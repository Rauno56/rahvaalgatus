var _ = require("root/lib/underscore")
var Qs = require("querystring")
var {Router} = require("express")
var HttpError = require("standard-http-error")
var Initiative = require("root/lib/initiative")
var DateFns = require("date-fns")
var Time = require("root/lib/time")
var Config = require("root").config
var Crypto = require("crypto")
var MediaType = require("medium-type")
var Subscription = require("root/lib/subscription")
var ResponseTypeMiddeware =
	require("root/lib/middleware/response_type_middleware")
var sha256 = require("root/lib/crypto").hash.bind(null, "sha256")
var initiativesDb = require("root/db/initiatives_db")
var subscriptionsDb = require("root/db/initiative_subscriptions_db")
var signaturesDb = require("root/db/initiative_signatures_db")
var messagesDb = require("root/db/initiative_messages_db")
var eventsDb = require("root/db/initiative_events_db")
var imagesDb = require("root/db/initiative_images_db")
var filesDb = require("root/db/initiative_files_db")
var textsDb = require("root/db/initiative_texts_db")
var commentsDb = require("root/db/comments_db")
var coauthorsDb = require("root/db/initiative_coauthors_db")
var next = require("co-next")
var t = require("root/lib/i18n").t.bind(null, Config.language)
var renderEmail = require("root/lib/i18n").email
var sql = require("sqlate")
var {sqlite} = require("root")
var {sendEmail} = require("root")
var searchInitiativeEvents = _.compose(searchInitiativesEvents, _.concat)
var parseText = require("./initiatives/texts_controller").parse
var {countUndersignedSignaturesById} = require("root/lib/initiative")
var {countCitizenOsSignaturesById} = require("root/lib/initiative")
var {parsePersonalId} = require("root/lib/user")
var {PHASES} = require("root/lib/initiative")
var EMPTY_ARR = Array.prototype
var EMPTY_INITIATIVE = {title: "", phase: "edit"}
var EMPTY_CONTACT = {name: "", email: "", phone: ""}
var LOCAL_GOVERNMENTS = require("root/lib/local_governments")
var MAX_URL_LENGTH = 1024
var INITIATIVE_TYPE =
	new MediaType("application/vnd.rahvaalgatus.initiative+json; v=1")
exports.searchInitiativesEvents = searchInitiativesEvents
exports.serializeApiInitiative = serializeApiInitiative
exports.router = Router({mergeParams: true})

exports.router.get("/",
	new ResponseTypeMiddeware(["text/html", INITIATIVE_TYPE].map(MediaType)),
	function(req, res) {
	if (res.contentType.name == INITIATIVE_TYPE.name) {
		res.setHeader("Content-Type", INITIATIVE_TYPE)
		res.setHeader("Access-Control-Allow-Origin", "*")
	}

	var gov = req.government
	var onlyDestinations = req.query.for && parseDestinations(req.query.for)
	var onlyPhase = req.query.phase && parsePhase(req.query.phase)

	// Perhaps it's worth changing the query parameter name to "tag". Remember
	// backwards compatibility!
	var tag = req.query.category

	var signedSince = (
		req.query.signedSince &&
		Time.parse(req.query.signedSince)
	)

	var [orderBy, orderDir] = req.query.order ? parseOrder(req.query.order) : []
	var limit = req.query.limit ? parseLimit(req.query.limit) : null

	var initiatives = initiativesDb.search(sql`
		${signedSince ? sql`
			WITH recent_signatures AS (
				SELECT initiative_uuid FROM initiative_signatures
				WHERE created_at >= ${signedSince}
				UNION ALL
				SELECT initiative_uuid FROM initiative_citizenos_signatures
				WHERE created_at >= ${signedSince}
			)
		` : sql``}

		SELECT
			initiative.*,
			user.name AS user_name,
			${initiativesDb.countSignatures(sql`initiative_uuid = initiative.uuid`)}
			AS signature_count

			${signedSince ? sql`,
				COUNT(recent.initiative_uuid) AS recent_signature_count
			` : sql``}

		FROM initiatives AS initiative
		${tag ? sql`JOIN json_each(initiative.tags) AS tag` : sql``}

		LEFT JOIN users AS user ON user.id = initiative.user_id

		${signedSince ? sql`
			JOIN recent_signatures AS recent
			ON recent.initiative_uuid = initiative.uuid
		` : sql``}

		WHERE initiative.published_at IS NOT NULL

		AND (destination IS NULL AND phase = 'edit' OR destination ${
			gov == null ? sql`IS NOT NULL` :
			gov == "parliament" ? sql`= 'parliament'` : sql`!= 'parliament'`
		})

		${onlyDestinations
			? sql`AND destination IN ${sql.in(onlyDestinations)}`
			: sql``
		}

		${onlyPhase ? sql`AND phase = ${onlyPhase}` : sql``}
		${tag ? sql`AND tag.value = ${tag}` : sql``}

		GROUP BY initiative.uuid

		${
			orderBy == "signatureCount"
			? sql`ORDER BY signature_count ${orderDir}`
			: orderBy == "signaturesSinceCount" && signedSince
			? sql`ORDER BY recent_signature_count ${orderDir}`
			: sql``
		}

		${limit != null ? sql`LIMIT ${limit}` : sql``}
	`)

	switch (res.contentType.name) {
		case INITIATIVE_TYPE.name:
			return void res.send(initiatives.map(function(initiative) {
				var obj = serializeApiInitiative(initiative)

				if (initiative.recent_signature_count)
					obj.signaturesSinceCount = initiative.recent_signature_count

				return obj
			}))

		default: res.render("initiatives/index_page.jsx", {
			initiatives: initiatives,
			onlyDestinations: onlyDestinations || EMPTY_ARR
		})
	}
})

exports.router.post("/", function(req, res) {
	var {user} = req
	if (user == null) throw new HttpError(401)

	var attrs = parseText(req.body)

	var initiative = initiativesDb.create({
		uuid: _.serializeUuid(_.uuidV4()),
		user_id: user.id,
		title: attrs.title,
		language: attrs.language,
		created_at: new Date,
		undersignable: true
	})

	textsDb.create({
		__proto__: attrs,
		initiative_uuid: initiative.uuid,
		user_id: user.id,
		created_at: new Date
	})

	res.statusMessage = "Initiative Created"
	res.redirect(303, req.baseUrl + "/" + initiative.uuid)
})

exports.router.get("/new", function(req, res) {
	var {user} = req
	if (user == null) throw new HttpError(401)

	res.render("initiatives/update_page.jsx", {
		initiative: EMPTY_INITIATIVE,
		language: "et"
	})
})

exports.router.use("/:id", function(req, res, next) {
	var {user} = req

	var initiative = initiativesDb.read(sql`
		SELECT
			initiative.*,
			user.name AS user_name,
			${initiativesDb.countSignatures(sql`initiative_uuid = initiative.uuid`)}
			AS signature_count

		FROM initiatives AS initiative
		LEFT JOIN users AS user ON user.id = initiative.user_id
		WHERE initiative.uuid = ${req.params.id}
	`)

	if (initiative == null) throw new HttpError(404)

	if (!initiative.published_at && !user)
		throw new HttpError(401, "Initiative Not Public")

	var coauthors = coauthorsDb.search(sql`
		SELECT coauthor.*, user.name AS user_name
		FROM initiative_coauthors AS coauthor
		LEFT JOIN users AS user ON user.id = coauthor.user_id
		WHERE coauthor.initiative_uuid = ${initiative.uuid}
		AND status IN ('accepted', 'pending')
	`)

	var isAuthorOrPendingAuthor = user && (
		initiative.user_id == user.id ||
		_.find(coauthors, {country: user.country, personal_id: user.personal_id})
	)

	if (!(initiative.published_at || isAuthorOrPendingAuthor))
		throw new HttpError(403, "Initiative Not Public")

	if ((req.method == "HEAD" || req.method == "GET") && !isApiRequest(req)) {
		var isLocalInitiative = Initiative.isLocalInitiative(initiative)

		if (req.government != "local" && isLocalInitiative)
			return void res.redirect(301, Config.localSiteUrl + req.originalUrl)
		else if (req.government != null && !isLocalInitiative)
			return void res.redirect(301, Config.url + req.originalUrl)
	}

	initiative.coauthors = coauthors.filter((a) => a.status == "accepted")

	req.initiative = initiative
	res.locals.initiative = initiative
	req.coauthorInvitations = coauthors.filter((a) => a.status == "pending")

	next()
})

exports.router.use("/:id/coauthors",
	require("./initiatives/coauthors_controller").router)

exports.router.use("/:id", function(req, res, next) {
	var {user} = req
	var {initiative} = req

	var isAuthor = user && Initiative.isAuthor(user, initiative)
	if (initiative.published_at || isAuthor) return void next()

	var coauthorInvitation = user && _.find(req.coauthorInvitations, {
		country: user.country,
		personal_id: user.personal_id
	})

	if (coauthorInvitation) {
		res.statusCode = 403
		res.statusMessage = "Accept Invitation"
		return void res.render("initiatives/coauthor_invitation_page.jsx", {
			invitation: coauthorInvitation
		})
	}

	throw new HttpError(403, "Initiative Not Public")
})

exports.router.get("/:id",
	new ResponseTypeMiddeware([
		"text/html",
		INITIATIVE_TYPE,
		"application/atom+xml"
	].map(MediaType), [
		"image/*"
	].map(MediaType)),
	function(req, res, next) {
	var type = res.contentType
	var {initiative} = req

	if (type.type == "image") {
		var image = imagesDb.read(sql`
			SELECT type, preview
			FROM initiative_images
			WHERE initiative_uuid = ${initiative.uuid}
		`)

		if (!image) throw new HttpError(406)
		if (!image.type.match(type)) throw new HttpError(406)

		res.setHeader("Content-Type", image.type)
		res.setHeader("Content-Length", image.preview.length)
		res.end(image.preview)
	}
	else switch (type.name) {
		case INITIATIVE_TYPE.name:
			res.setHeader("Content-Type", type)
			res.setHeader("Access-Control-Allow-Origin", "*")
			res.send(serializeApiInitiative(initiative))
			break

		case "application/atom+xml":
			var events = searchInitiativeEvents(initiative)
			res.setHeader("Content-Type", type)
			res.render("initiatives/atom.jsx", {events: events})
			break

		default: exports.read(req, res, next)
	}
})

exports.read = function(req, res) {
	var {user} = req
	var {initiative} = req
	var thank = false
	var thankAgain = false
	var signature
	var newSignatureToken = req.flash("signatureToken")
	var textLanguage = req.query.language || initiative.language

	if (initiative.phase == "sign") if (newSignatureToken) {
		signature = signaturesDb.read(sql`
			SELECT * FROM initiative_signatures
			WHERE initiative_uuid = ${initiative.uuid}
			AND token = ${Buffer.from(newSignatureToken, "hex")}
		`)

		thank = !!signature
		thankAgain = signature && signature.oversigned > 0
	}
	else if (user) signature = signaturesDb.read(sql`
		SELECT * FROM initiative_signatures
		WHERE initiative_uuid = ${initiative.uuid}
		AND country = ${user.country}
		AND personal_id = ${user.personal_id}
	`)

	var subscriberCounts = sqlite(sql`
		SELECT
			SUM(initiative_uuid IS NULL) AS "all",
			SUM(initiative_uuid IS NOT NULL) AS initiative

		FROM initiative_subscriptions
		WHERE confirmed_at IS NOT NULL AND (
			initiative_uuid IS NULL OR
			initiative_uuid = ${initiative.uuid}
		)
	`)[0]

	var comments = searchInitiativeComments(initiative.uuid)
	var events = searchInitiativeEvents(initiative)

	var subscription = user && user.email && user.email_confirmed_at
		? subscriptionsDb.read(sql`
			SELECT * FROM initiative_subscriptions
			WHERE initiative_uuid = ${initiative.uuid}
			AND email = ${user.email}
			LIMIT 1
		`)
		: null

	var files = filesDb.search(sql`
		SELECT id, name, title, content_type, length(content) AS size
		FROM initiative_files
		WHERE initiative_uuid = ${initiative.uuid}
		AND event_id IS NULL
	`)

	var image = imagesDb.read(sql`
		SELECT initiative_uuid, type, author_name, author_url
		FROM initiative_images
		WHERE initiative_uuid = ${initiative.uuid}
	`)

	var text = textsDb.read(sql`
		SELECT * FROM initiative_texts
		WHERE initiative_uuid = ${initiative.uuid}
		AND language = ${textLanguage}
		ORDER BY id DESC
		LIMIT 1
	`)

	if (text == null && initiative.language != textLanguage) {
		res.statusMessage = "No Translation"
		return void res.redirect(307, req.baseUrl + req.path)
	}

	if (text) initiative.title = text.title

	if (req.originalUrl.endsWith(".html")) {
		var html = (
			initiative.text ||
			text && Initiative.renderForParliament(text)
		)

		if (html) return void res.send(html)
		else throw new HttpError(404, "No Text Yet")
	}

	var translations = _.indexBy(textsDb.search(sql`
		SELECT language, id
		FROM initiative_texts

		WHERE id IN (
			SELECT MAX(id) FROM initiative_texts
			WHERE initiative_uuid = ${initiative.uuid}
			AND language != ${initiative.language}
			GROUP BY language
		)
	`), "language")

	var coauthorInvitation = user && _.find(req.coauthorInvitations, {
		country: user.country,
		personal_id: user.personal_id
	})

	res.render("initiatives/read_page.jsx", {
		thank: thank,
		thankAgain: thankAgain,
		signature: !signature || signature.hidden ? null : signature,
		subscription: subscription,
		subscriberCounts: subscriberCounts,
		text: text,
		textLanguage: textLanguage,
		translations: translations,
		coauthorInvitation,
		image: image,
		files: files,
		comments: comments,
		events: events
	})
}

exports.router.put("/:id", next(function*(req, res) {
	var {user} = req
	if (user == null) throw new HttpError(401)

	var {initiative} = req

	var isAuthor = Initiative.isAuthor(user, initiative)
	if (!isAuthor) throw new HttpError(403, "No Permission to Edit")

	if (req.body.visibility === "public") {
		yield updateInitiativeToPublished(req, res)
	}
	else if (req.body.status === "voting") {
		yield updateInitiativePhaseToSign(req, res)
	}
	else if (req.body.status === "followUp") {
		yield updateInitiativePhaseToParliament(req, res)
	}
	else if (req.body.author_personal_id) {
		updateInitiativeAuthor(req, res)
	}
	else if (isInitiativeUpdate(req.body)) {
		var attrs = parseInitiative(initiative, req.body)
		initiativesDb.update(initiative.uuid, attrs)
		res.flash("notice", req.t("INITIATIVE_INFO_UPDATED"))
		res.redirect(303, req.headers.referer || req.baseUrl + req.url)
	}
	else throw new HttpError(422, "Invalid Attribute")
}))

exports.router.delete("/:id", function(req, res) {
	var {user} = req
	if (user == null) throw new HttpError(401)

	var {initiative} = req

	if (initiative.user_id != user.id)
		throw new HttpError(403, "No Permission to Delete")
	if (initiative.phase != "edit")
		throw new HttpError(405, "Can Only Delete Discussions")

	if (initiative.published_at && commentsDb.select1(sql`
		SELECT COUNT(*) AS count FROM comments
		WHERE initiative_uuid = ${initiative.uuid}
	`).count > 0) {
		res.flash("notice", req.t("INITIATIVE_CANNOT_BE_DELETED_HAS_COMMENTS"))
		res.redirect(303, req.baseUrl + req.path)
		return
	}

	commentsDb.execute(sql`
		DELETE FROM comments
		WHERE initiative_uuid = ${initiative.uuid}
	`)

	textsDb.execute(sql`
		DELETE FROM initiative_texts
		WHERE initiative_uuid = ${initiative.uuid}
	`)

	initiativesDb.delete(initiative.uuid)
	res.flash("notice", req.t("INITIATIVE_DELETED"))
	res.redirect(303, req.baseUrl)
})

exports.router.get("/:id/edit", function(req, res) {
	var {user} = req
	if (user == null) throw new HttpError(401)

	var {initiative} = req

	var isAuthor = user && Initiative.isAuthor(user, initiative)
	if (!isAuthor) throw new HttpError(403, "No Permission to Edit")

	var text = textsDb.read(sql`
		SELECT * FROM initiative_texts
		WHERE initiative_uuid = ${initiative.uuid}
		AND language = ${req.query.language || initiative.language}
		ORDER BY created_at DESC
		LIMIT 1
	`)

	var path = req.baseUrl + "/" + initiative.uuid + "/texts"
	if (text) res.redirect(path + "/" + text.id)
	else res.redirect(path + "/new?language=" + initiative.language)
})

exports.router.use("/:id/image",
	require("./initiatives/image_controller").router)
exports.router.use("/:id/comments",
	require("./initiatives/comments_controller").router)
exports.router.use("/:id/files",
	require("./initiatives/files_controller").router)
exports.router.use("/:id/events",
	require("./initiatives/events_controller").router)
exports.router.use("/:id/subscriptions",
	require("./initiatives/subscriptions_controller").router)
exports.router.use("/:id/signatures",
	require("./initiatives/signatures_controller").router)
exports.router.use("/:id/texts",
	require("./initiatives/texts_controller").router)

exports.router.use(function(err, req, res, next) {
	if (err instanceof HttpError && err.code === 404) {
		res.statusCode = err.code
		res.statusMessage = err.message

		res.render("error_page.jsx", {
			title: req.t("INITIATIVE_404_TITLE"),
			body: req.t("INITIATIVE_404_BODY")
		})
	}
	else next(err)
})

function searchInitiativesEvents(initiatives) {
	var events = eventsDb.search(sql`
		SELECT
			event.*,
			user.name AS user_name,

			json_group_array(json_object(
				'id', file.id,
				'name', file.name,
				'title', file.title,
				'url', file.url,
				'content_type', file.content_type,
				'size', length(file.content)
			)) AS files

		FROM initiative_events AS event
		LEFT JOIN initiative_files AS file on file.event_id = event.id
		LEFT JOIN users AS user ON event.user_id = user.id
		WHERE event.initiative_uuid IN ${sql.in(initiatives.map((i) => i.uuid))}
		GROUP BY event.id
		ORDER BY event.occurred_at ASC
	`)

	events.forEach(function(ev) {
		ev.files = JSON.parse(ev.files).filter((f) => f.id).map(filesDb.parse)
	})

	var eventsByInitiativeUuid = _.groupBy(events, "initiative_uuid")

	return _.flatten(initiatives.map(function(initiative) {
		var events = eventsByInitiativeUuid[initiative.uuid] || EMPTY_ARR
		var sentToParliamentAt = initiative.sent_to_parliament_at
		var finishedInParliamentAt = initiative.finished_in_parliament_at
		var sentToGovernmentAt = initiative.sent_to_government_at
		var finishedInGovernmentAt = initiative.finished_in_government_at

		return _.concat(
			sentToParliamentAt ? {
				id: "sent-to-parliament",
				initiative_uuid: initiative.uuid,
				type: "sent-to-parliament",
				updated_at: sentToParliamentAt,
				occurred_at: sentToParliamentAt,
				origin: "system"
			} : EMPTY_ARR,

			_.map(initiative.signature_milestones, (at, milestone) => ({
				id: "milestone-" + milestone,
				initiative_uuid: initiative.uuid,
				type: "signature-milestone",
				content: milestone,
				updated_at: at,
				occurred_at: at,
				origin: "system"
			})),

			events,

			(
				finishedInParliamentAt &&
				!events.some((ev) => ev.type == "parliament-finished")
			) ? {
				id: "parliament-finished",
				initiative_uuid: initiative.uuid,
				updated_at: finishedInParliamentAt,
				occurred_at: finishedInParliamentAt,
				type: "parliament-finished",
				origin: "system"
			} : EMPTY_ARR,

			sentToGovernmentAt ? {
				id: "sent-to-government",
				initiative_uuid: initiative.uuid,
				type: "sent-to-government",
				updated_at: sentToGovernmentAt,
				occurred_at: sentToGovernmentAt,
				origin: "system"
			} : EMPTY_ARR,

			finishedInGovernmentAt ? {
				id: "finished-in-government",
				initiative_uuid: initiative.uuid,
				updated_at: finishedInGovernmentAt,
				occurred_at: finishedInGovernmentAt,
				type: "finished-in-government",
				origin: "system"
			} : EMPTY_ARR
		)
	}))
}

function searchInitiativeComments(initiativeUuid) {
	var comments = commentsDb.search(sql`
		SELECT comment.*, user.name AS user_name
		FROM comments AS comment
		LEFT JOIN users AS user
		ON comment.user_id = user.id AND comment.anonymized_at IS NULL
		WHERE comment.initiative_uuid = ${initiativeUuid}
		ORDER BY comment.created_at
	`)

	var parentsAndReplies = _.partition(comments, (c) => c.parent_id == null)
	var parentsById = _.indexBy(parentsAndReplies[0], "id")

	parentsAndReplies[1].forEach(function(comment) {
		var parent = parentsById[comment.parent_id]
		;(parent.replies || (parent.replies = [])).push(comment)
	})

	return parentsAndReplies[0]
}

function isInitiativeUpdate(obj) {
	return (
		"destination" in obj ||
		"author_name" in obj ||
		"author_url" in obj ||
		"author_contacts" in obj ||
		"url" in obj ||
		"community_url" in obj ||
		"organizations" in obj ||
		"media_urls" in obj ||
		"meetings" in obj ||
		"government_change_urls" in obj ||
		"public_change_urls" in obj ||
		"notes" in obj
	)
}

function* updateInitiativeToPublished(req, res) {
	var {user} = req
	var {initiative} = req
	if (initiative.phase != "edit") throw new HttpError(403, "Already Published")

	var tmpl = "initiatives/update_for_publish_page.jsx"

	if (!Initiative.canPublish(user)) throw new HttpError(403, "Cannot Publish")

	if (!textsDb.read(sql`
		SELECT id FROM initiative_texts
		WHERE initiative_uuid = ${initiative.uuid}
		LIMIT 1
	`)) throw new HttpError(422, "No Text")

	if (req.body.endsOn == null) return void res.render(tmpl, {
		attrs: {endsAt: initiative.discussion_ends_at}
	})

	var endsOn = Time.parseIsoDate(req.body.endsOn)
	var endsAt = DateFns.addDays(endsOn, 1)

	if (!Initiative.isDeadlineOk(
		initiative.published_at || new Date,
		new Date,
		endsAt
	)) {
		res.statusCode = 422
		res.statusMessage = "Deadline Too Near or Too Far"

		return void res.render(tmpl, {
			error: req.t("INITIATIVE_DISCUSSION_DEADLINE_ERROR", {
				days: Config.minDeadlineDays
			}),

			attrs: {endsAt: endsAt}
		})
	}

	var emailSentAt = initiative.discussion_end_email_sent_at

	initiativesDb.update(initiative.uuid, {
		published_at: initiative.published_at || new Date,
		discussion_ends_at: endsAt,
		discussion_end_email_sent_at: endsAt > new Date ? null : emailSentAt
	})

	if (initiative.published_at == null && user.email) {
		var subscription = subscriptionsDb.read(sql`
			SELECT * FROM initiative_subscriptions
			WHERE (initiative_uuid, email) = (${initiative.uuid}, ${user.email})
		`)

		if (subscription) subscriptionsDb.update(subscription, {
			event_interest: true,
			comment_interest: true,
			confirmed_at: subscription.confirmed_at || new Date,
			updated_at: new Date
		})
		else subscriptionsDb.create({
			initiative_uuid: initiative.uuid,
			email: user.email,
			created_at: new Date,
			created_ip: req.ip,
			updated_at: new Date,
			confirmed_at: new Date,
			comment_interest: true
		})
	}

	if (initiative.published_at == null) {
		var message = messagesDb.create({
			initiative_uuid: initiative.uuid,
			origin: "status",
			created_at: new Date,
			updated_at: new Date,

			title: t("INITIATIVE_PUBLISHED_MESSAGE_TITLE", {
				initiativeTitle: initiative.title
			}),

			text: renderEmail("et", "INITIATIVE_PUBLISHED_MESSAGE_BODY", {
				initiativeTitle: initiative.title,
				initiativeUrl: `${Config.url}/initiatives/${initiative.uuid}`,
				authorName: user.name
			})
		})

		yield Subscription.send(
			message,
			subscriptionsDb.searchConfirmedForNewInitiative()
		)
	}

	res.flash("notice", initiative.published_at == null
		? req.t("PUBLISHED_INITIATIVE")
		: req.t("INITIATIVE_DISCUSSION_DEADLINE_UPDATED")
	)

	res.statusMessage = initiative.published_at == null
		? "Initiative Published"
		: "Initiative Updated"

	res.redirect(303, req.baseUrl + "/" + initiative.uuid)
}

function* updateInitiativePhaseToSign(req, res) {
	var {user} = req
	var {initiative} = req
	var tmpl = "initiatives/update_for_voting_page.jsx"

	if (!(
		Initiative.canPropose(new Date, initiative, user) ||
		Initiative.canUpdateSignDeadline(initiative, user)
	)) throw new HttpError(403, "Cannot Update to Sign Phase")

	res.locals.texts = _.indexBy(textsDb.search(sql`
		SELECT title, language, created_at
		FROM initiative_texts
		WHERE id IN (
			SELECT MAX(id) FROM initiative_texts
			WHERE initiative_uuid = ${initiative.uuid}
			GROUP BY language
		)
	`), "language")

	if (req.body.endsOn == null) return void res.render(tmpl, {
		attrs: {endsAt: initiative.signing_ends_at}
	})

	var lang = req.body.language
	var endsOn = Time.parseIsoDate(req.body.endsOn)
	var endsAt = DateFns.addDays(endsOn, 1)
	var attrs = {endsAt: endsAt}

	if (!Initiative.isDeadlineOk(
		initiative.signing_started_at || new Date,
		new Date,
		endsAt
	)) {
		res.statusCode = 422
		res.statusMessage = "Deadline Too Near or Too Far"

		return void res.render(tmpl, {
			error: req.t("INITIATIVE_SIGN_DEADLINE_ERROR", {
				days: Config.minDeadlineDays
			}),

			attrs: attrs
		})
	}

	var emailSentAt = initiative.signing_end_email_sent_at

	attrs = {
		phase: "sign",
		signing_started_at: initiative.signing_started_at || new Date,
		signing_ends_at: endsAt,
		signing_end_email_sent_at: endsAt > new Date ? null : emailSentAt
	}

	if (initiative.phase == "edit") {
		var text = textsDb.read(sql`
			SELECT * FROM initiative_texts
			WHERE initiative_uuid = ${initiative.uuid} AND language = ${lang}
			ORDER BY id DESC
			LIMIT 1
		`)

		if (text == null) throw new HttpError(422, "No Text")

		if (text.language != "et" && !hasEstonianTranslation(initiative))
			throw new HttpError(403, "No Estonian Translation")

		var html = Initiative.renderForParliament(text)

		attrs.text = html
		attrs.text_type = new MediaType("text/html")
		attrs.text_sha256 = sha256(html)
		attrs.title = text.title
		attrs.language = lang
	}

	initiativesDb.update(initiative, attrs)

	if (initiative.phase == "edit") {
		var message = messagesDb.create({
			initiative_uuid: initiative.uuid,
			origin: "status",
			created_at: new Date,
			updated_at: new Date,

			title: t("SENT_TO_SIGNING_MESSAGE_TITLE", {
				initiativeTitle: initiative.title
			}),

			text: renderEmail("et", "SENT_TO_SIGNING_MESSAGE_BODY", {
				initiativeTitle: initiative.title,
				initiativeUrl: `${Config.url}/initiatives/${initiative.uuid}`,
			})
		})

		yield Subscription.send(
			message,

			_.uniqBy(_.concat(
				subscriptionsDb.searchConfirmedForSignableInitiative(),
				subscriptionsDb.searchConfirmedByInitiativeIdForEvent(initiative.uuid)
			), "email")
		)
	}

	res.flash("notice", initiative.phase == "edit"
		? req.t("INITIATIVE_SIGN_PHASE_UPDATED")
		: req.t("INITIATIVE_SIGNING_DEADLINE_UPDATED")
	)

	res.statusMessage = initiative.signing_started_at == null
		? "Initiative Sent to Signing"
		: "Initiative Updated"

	res.redirect(303, req.baseUrl + "/" + initiative.uuid)
}

function* updateInitiativePhaseToParliament(req, res) {
	var {user} = req
	var {initiative} = req
	var {uuid} = initiative
	var citizenosSignatureCount = countCitizenOsSignaturesById(uuid)
	var undersignedSignatureCount = countUndersignedSignaturesById(uuid)
	var signatureCount = citizenosSignatureCount + undersignedSignatureCount
	var tmpl = "initiatives/update_for_parliament_page.jsx"

	if (initiative.user_id != user.id)
		throw new HttpError(403, "No Permission to Edit")

	if (!(
		Initiative.canSendToParliament(initiative, user, signatureCount) ||
		Initiative.canSendToLocalGovernment(initiative, user, signatureCount)
	)) throw new HttpError(403, "Cannot Send")

	if (initiative.language != "et" && !hasEstonianTranslation(initiative))
		throw new HttpError(403, "No Estonian Translation")

	var attrs = {
		status: req.body.status,
		contact: req.body.contact || EMPTY_CONTACT
	}

	if (req.body.contact == null) return void res.render(tmpl, {attrs: attrs})

	if (initiative.destination == "parliament")
		initiative = initiativesDb.update(initiative, {
			phase: "parliament",
			sent_to_parliament_at: new Date,
			parliament_token: Crypto.randomBytes(12)
		})
	else
		initiative = initiativesDb.update(initiative, {
			phase: "government",
			sent_to_government_at: new Date,
			parliament_token: Crypto.randomBytes(12)
		})

	var initiativeUrl = Initiative.initiativeUrl(initiative)
	var parliamentToken = initiative.parliament_token.toString("hex")

	var undersignedSignaturesUrl =
		`${initiativeUrl}/signatures.asice?` +
		Qs.stringify({"parliament-token": parliamentToken})

	var citizenosSignaturesUrl =
		`${initiativeUrl}/signatures.zip?` +
		Qs.stringify({type: "citizenos", "parliament-token": parliamentToken})

	var signaturesCsvUrl =
		`${initiativeUrl}/signatures.csv?` +
		Qs.stringify({"parliament-token": parliamentToken})

	var emails = initiative.destination == "parliament"
		? [Config.parliamentEmail]
		: LOCAL_GOVERNMENTS[initiative.destination].initiativesEmails

	var localGovernmentGuideUrl = Config.url + "/help/kov-guide.pdf"

	yield sendEmail({
		envelope: {to: emails},
		to: {name: "", address: "%recipient%"},

		headers: {
			"X-Mailgun-Recipient-Variables": JSON.stringify(
				_.object(emails, _.const({}))
			)
		},

		subject: t(initiative.destination == "parliament"
			? "EMAIL_INITIATIVE_TO_PARLIAMENT_TITLE"
			: "EMAIL_INITIATIVE_TO_LOCAL_GOVERNMENT_TITLE"
			, {
			initiativeTitle: initiative.title
		}),

		text: renderEmail(
			"et",
			initiative.destination != "parliament"
			? "EMAIL_INITIATIVE_TO_LOCAL_GOVERNMENT_BODY"
			: citizenosSignatureCount > 0
			? "EMAIL_INITIATIVE_TO_PARLIAMENT_WITH_CITIZENOS_SIGNATURES_BODY"
			: "EMAIL_INITIATIVE_TO_PARLIAMENT_BODY", {
			initiativeTitle: initiative.title,
			initiativeUrl: initiativeUrl,
			initiativeUuid: initiative.uuid,

			signatureCount: signatureCount,
			undersignedSignaturesUrl: undersignedSignaturesUrl,
			citizenosSignaturesUrl: citizenosSignaturesUrl,
			signaturesCsvUrl: signaturesCsvUrl,
			guideUrl: localGovernmentGuideUrl,

			authorName: attrs.contact.name,
			authorEmail: attrs.contact.email,
			authorPhone: attrs.contact.phone,
		})
	})

	var message = messagesDb.create({
		initiative_uuid: initiative.uuid,
		origin: "status",
		created_at: new Date,
		updated_at: new Date,

		title: t(
			initiative.destination == "parliament"
			? "SENT_TO_PARLIAMENT_MESSAGE_TITLE"
			: "SENT_TO_LOCAL_GOVERNMENT_MESSAGE_TITLE", {
			initiativeTitle: initiative.title
		}),

		text: renderEmail("et", initiative.destination == "parliament"
			? "SENT_TO_PARLIAMENT_MESSAGE_BODY"
			: "SENT_TO_LOCAL_GOVERNMENT_MESSAGE_BODY", {
			authorName: attrs.contact.name,
			initiativeTitle: initiative.title,
			initiativeUrl: initiativeUrl,
			signatureCount: signatureCount
		})
	})

	yield Subscription.send(
		message,
		subscriptionsDb.searchConfirmedByInitiativeIdForEvent(initiative.uuid)
	)

	res.flash("notice", initiative.destination == "parliament"
		? req.t("SENT_TO_PARLIAMENT_CONTENT")
		: req.t("SENT_TO_LOCAL_GOVERNMENT_CONTENT")
	)

	res.redirect(303, req.baseUrl + "/" + initiative.uuid)
}

function updateInitiativeAuthor(req, res) {
	var {user} = req
	var {initiative} = req
	var [country, personalId] = parsePersonalId(req.body.author_personal_id)

	if (initiative.user_id != user.id)
		throw new HttpError(403, "Only Author Can Update Author")
	if (initiative.phase != "edit")
		throw new HttpError(403, "Can Only Update Author In Edit")

	var coauthor = coauthorsDb.read(sql`
		SELECT coauthor.*, user.name AS user_name
		FROM initiative_coauthors AS coauthor
		JOIN users AS user ON user.id = coauthor.user_id
		WHERE coauthor.initiative_uuid = ${initiative.uuid}
		AND coauthor.country = ${country}
		AND coauthor.personal_id = ${personalId}
		AND coauthor.status = 'accepted'
	`)

	if (coauthor == null) throw new HttpError(422, "No Such Coauthor")

	initiativesDb.update(initiative.uuid, {user_id: coauthor.user_id})

	coauthorsDb.update(coauthor, {
		status: "promoted",
		status_updated_at: new Date,
		status_updated_by_id: user.id
	})

	coauthorsDb.create({
		initiative_uuid: initiative.uuid,
		user_id: user.id,
		country: user.country,
		personal_id: user.personal_id,
		created_at: new Date,
		created_by_id: user.id,
		status: "accepted",
		status_updated_at: new Date,
		status_updated_by_id: user.id
	})

	res.flash("notice", req.t("INITIATIVE_UPDATE_AUTHOR_UPDATED", {
		name: coauthor.user_name
	}))

	res.statusMessage = "Author Updated"
	res.redirect(303, req.baseUrl + req.url)
}

function hasEstonianTranslation(initiative) {
	return Boolean(textsDb.read(sql`
		SELECT true
		FROM initiative_texts
		WHERE initiative_uuid = ${initiative.uuid} AND language = 'et'
		ORDER BY id DESC
		LIMIT 1
	`))
}

var validateInitiativeAttributes = require("root/lib/json_schema").new({
	type: "object",
	additionalProperties: false,

	properties: {
		destination: {
			enum: _.concat(null, "parliament", _.keys(LOCAL_GOVERNMENTS))
		},

		author_name: {type: "string", maxLength: 100},
		author_url: {type: "string", maxLength: MAX_URL_LENGTH},
		author_contacts: {type: "string", maxLength: 500},
		url: {type: "string", maxLength: MAX_URL_LENGTH},
		community_url: {type: "string", maxLength: MAX_URL_LENGTH},

		// The initiative at
		// https://rahvaalgatus.ee/initiatives/c6b17445-f45b-488e-8778-3815f82c5f31
		// has 6285 characters of notes. The second place goes to
		// https://kohalik.rahvaalgatus.ee/initiatives/1e9b5c2a-2485-43db-a6d2-ba082d326c34
		// with 1791 chracters. To not break their editing for now, limit at 8k.
		notes: {type: "string", maxLength: 8000},

		organizations: {
			type: "array",

			items: {
				type: "object",
				additionalProperties: false,

				properties: {
					name: {type: "string", maxLength: 100},
					url: {type: "string", maxLength: MAX_URL_LENGTH}
				}
			}
		},

		meetings: {
			type: "array",

			items: {
				type: "object",
				additionalProperties: false,

				properties: {
					date: {type: "string", format: "date"},
					url: {type: "string", maxLength: MAX_URL_LENGTH}
				}
			}
		},

		media_urls: {
			type: "array",
			items: {type: "string", maxLength: MAX_URL_LENGTH}
		},

		government_change_urls: {
			type: "array",
			items: {type: "string", maxLength: MAX_URL_LENGTH}
		},

		public_change_urls: {
			type: "array",
			items: {type: "string", maxLength: MAX_URL_LENGTH}
		}
	}
})

exports.SCHEMA = validateInitiativeAttributes.schema

function parseInitiative(initiative, obj) {
	var err, attrs = {}

	if ("destination" in obj && initiative.phase == "edit")
		attrs.destination = obj.destination || null

	if ("author_name" in obj) attrs.author_name = String(obj.author_name).trim()
	if ("author_url" in obj) attrs.author_url = String(obj.author_url).trim()

	if ("author_contacts" in obj)
		attrs.author_contacts = String(obj.author_contacts).trim()

	if ("url" in obj) attrs.url = String(obj.url).trim()
	if ("notes" in obj) attrs.notes = String(obj.notes).trim()

	if ("community_url" in obj)
		attrs.community_url = String(obj.community_url).trim()

	if ("organizations" in obj) attrs.organizations =
		obj.organizations.map(parseOrganization).filter(isOrganizationPresent)

	if ("meetings" in obj) attrs.meetings =
		obj.meetings.map(parseMeeting).filter(isMeetingPresent)

	if ("media_urls" in obj) attrs.media_urls =
		obj.media_urls.map(String).map(_.trim).filter(Boolean)

	if ("government_change_urls" in obj) attrs.government_change_urls =
		obj.government_change_urls.map(String).map(_.trim).filter(Boolean)

	if ("public_change_urls" in obj) attrs.public_change_urls =
		obj.public_change_urls.map(String).map(_.trim).filter(Boolean)

	if (err = validateInitiativeAttributes(attrs))
		throw new HttpError(422, "Invalid Attributes", {attributes: err})

	return attrs
}

function serializeApiInitiative(initiative) {
	return {
		id: initiative.uuid,
		for: initiative.destination,
		title: initiative.title,
		phase: initiative.phase,
		signatureCount: initiative.external ? null : initiative.signature_count
	}
}

function parseOrganization(obj) {
	return {
		name: String(obj.name || "").trim(),
		url: String(obj.url || "").trim()
	}
}

function parseMeeting(obj) {
	return {
		date: String(obj.date || "").trim(),
		url: String(obj.url || "").trim()
	}
}

function parseDestinations(dest) {
	return _.asArray(dest).filter(isValidDestination)
}

function parsePhase(phase) {
	if (PHASES.includes(phase)) return phase
	else throw new HttpError(400, "Invalid Phase")
}

function parseOrder(order) {
	var by = order.replace(/^[-+]/, "")
	order = order[0] == "-" ? sql`DESC` : sql`ASC`

	switch (by) {
		case "signatureCount":
		case "signaturesSinceCount": return [by, order]
		default: throw new HttpError(400, "Invalid Order")
	}
}

function parseLimit(limit) {
	limit = Number(limit)
	if (Number.isFinite(limit) && limit >= 0) return limit
	throw new HttpError(400, "Invalid Limit")
}

function isValidDestination(dest) {
	return dest == "parliament" || _.hasOwn(LOCAL_GOVERNMENTS, dest)
}

function isApiRequest(req) { return req.accept[0].name == INITIATIVE_TYPE.name }
function isOrganizationPresent(org) { return org.name || org.url }
function isMeetingPresent(org) { return org.date || org.url }
