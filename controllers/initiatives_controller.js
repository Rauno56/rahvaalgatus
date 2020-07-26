var _ = require("root/lib/underscore")
var Qs = require("querystring")
var Router = require("express").Router
var HttpError = require("standard-http-error")
var SqliteError = require("root/lib/sqlite_error")
var Initiative = require("root/lib/initiative")
var DateFns = require("date-fns")
var Time = require("root/lib/time")
var Config = require("root/config")
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
var next = require("co-next")
var t = require("root/lib/i18n").t.bind(null, Config.language)
var renderEmail = require("root/lib/i18n").email
var sql = require("sqlate")
var sqlite = require("root").sqlite
var concat = Array.prototype.concat.bind(Array.prototype)
var flatten = Function.apply.bind(Array.prototype.concat, Array.prototype)
var trim = Function.call.bind(String.prototype.trim)
var sendEmail = require("root").sendEmail
var searchInitiativeEvents = _.compose(searchInitiativesEvents, concat)
var parseText = require("./initiatives/texts_controller").parse
var {countSignaturesById} = require("root/lib/initiative")
var {countSignaturesByIds} = require("root/lib/initiative")
var {countUndersignedSignaturesById} = require("root/lib/initiative")
var {countCitizenOsSignaturesById} = require("root/lib/initiative")
var EMPTY = Object.prototype
var EMPTY_ARR = Array.prototype
var EMPTY_INITIATIVE = {title: "", phase: "edit"}
var EMPTY_CONTACT = {name: "", email: "", phone: ""}
var LOCAL_GOVERNMENTS = require("root/lib/local_governments")
var INITIATIVE_TYPE =
	new MediaType("application/vnd.rahvaalgatus.initiative+json; v=1")
exports.searchInitiativesEvents = searchInitiativesEvents
exports.serializeApiInitiative = serializeApiInitiative
exports.router = Router({mergeParams: true})

exports.router.get("/",
	new ResponseTypeMiddeware(["text/html", INITIATIVE_TYPE].map(MediaType)),
	next(function*(req, res) {
	var gov = req.government

	var initiatives = yield initiativesDb.search(sql`
		SELECT initiative.*, user.name AS user_name
		FROM initiatives AS initiative
		LEFT JOIN users AS user ON initiative.user_id = user.id

		WHERE published_at IS NOT NULL
		AND (destination IS NULL AND phase = 'edit' OR destination ${
			gov == null ? sql`IS NOT NULL` :
			gov == "parliament" ? sql`= 'parliament'` : sql`!= 'parliament'`
		})
	`)

	// Perhaps it's worth changing the query parameter name to "tag". Remember
	// backwards compatibility!
	var tag = req.query.category
	if (tag) initiatives = initiatives.filter((i) => i.tags.includes(tag))

	var signatureCounts = yield countSignaturesByIds(_.map(initiatives, "uuid"))

	var type = res.contentType
	switch (type.name) {
		case INITIATIVE_TYPE.name:
			// TODO: API initiative filtering should be done in SQL for the most part.
			res.setHeader("Content-Type", type)
			res.setHeader("Access-Control-Allow-Origin", "*")

			if (req.query.for !== undefined) {
				var dests = _.asArray(req.query.for)

				if (!dests.every(isValidDestination))
					throw new HttpError(400, "Invalid Destination")

				dests = new Set(dests)
				initiatives = initiatives.filter((i) => dests.has(i.destination))
			}

			switch (req.query.phase || undefined) {
				case "edit":
				case "sign":
				case "parliament":
				case "government":
				case "done":
					initiatives = initiatives.filter((initiative) => (
						initiative.phase == req.query.phase
					))
					break

				case undefined: break
				default: throw new HttpError(400, "Invalid Phase")
			}

			var signaturesSinceCounts = null
			if (req.query.signedSince)
				signaturesSinceCounts = yield countSignaturesByIdsAndTime(
					_.map(initiatives, "uuid"),
					DateFns.parse(req.query.signedSince)
				)

			var apiInitiatives = initiatives.map(function(initiative) {
				if (
					signaturesSinceCounts &&
					(initiative.external || !signaturesSinceCounts[initiative.uuid])
				) return null

				var obj = serializeApiInitiative(
					initiative,
					initiative.external ? null : signatureCounts[initiative.uuid]
				)

				if (signaturesSinceCounts)
					obj.signaturesSinceCount = signaturesSinceCounts[initiative.uuid]

				return obj
			}).filter(Boolean)

			var order = req.query.order
			switch (order || undefined) {
				case "signatureCount":
				case "+signatureCount":
				case "-signatureCount":
				case "signaturesSinceCount":
				case "+signaturesSinceCount":
				case "-signaturesSinceCount":
					apiInitiatives = _.sortBy(apiInitiatives, order.replace(/^[-+ ]/, ""))
					if (order[0] == "-") apiInitiatives = _.reverse(apiInitiatives)
					break

				case undefined: break
				default: throw new HttpError(400, "Invalid Order")
			}

			var limit = req.query.limit
			switch (limit || undefined) {
				case undefined: break
				default: apiInitiatives = apiInitiatives.slice(0, Number(limit))
			}

			res.send(apiInitiatives)
			break

		default:
			res.render("initiatives/index_page.jsx", {
				initiatives: initiatives,
				signatureCounts: signatureCounts
			})
	}
}))

exports.router.post("/", next(function*(req, res) {
	var user = req.user
	if (user == null) throw new HttpError(401)

	var attrs = parseText(req.body)

	var initiative = yield initiativesDb.create({
		uuid: _.serializeUuid(_.uuidV4()),
		user_id: user.id,
		title: attrs.title,
		language: attrs.language,
		created_at: new Date,
		undersignable: true
	})

	yield textsDb.create({
		__proto__: attrs,
		initiative_uuid: initiative.uuid,
		user_id: user.id,
		created_at: new Date
	})

	res.redirect(303, req.baseUrl + "/" + initiative.uuid)
}))

exports.router.get("/new", function(_req, res) {
	res.render("initiatives/update_page.jsx", {
		initiative: EMPTY_INITIATIVE,
		language: "et"
	})
})

exports.router.use("/:id", next(function*(req, res, next) {
	var user = req.user

	var initiative = yield initiativesDb.read(sql`
		SELECT initiative.*, user.name AS user_name
		FROM initiatives AS initiative
		LEFT JOIN users AS user ON initiative.user_id = user.id
		WHERE initiative.uuid = ${req.params.id}
	`)

	if (initiative == null) throw new HttpError(404)
	if (!initiative.published_at && !user)
		throw new HttpError(401, "Initiative Not Public")
	if (!initiative.published_at && initiative.user_id != user.id)
		throw new HttpError(403, "Initiative Not Public")

	if ((req.method == "HEAD" || req.method == "GET") && !isApiRequest(req)) {
		var isLocalInitiative = Initiative.isLocalInitiative(initiative)

		if (req.government != "local" && isLocalInitiative)
			return void res.redirect(301, Config.localSiteUrl + req.originalUrl)
		else if (req.government != null && !isLocalInitiative)
			return void res.redirect(301, Config.url + req.originalUrl)
	}

	req.initiative = initiative
	res.locals.initiative = initiative
	next()
}))

exports.router.get("/:id",
	new ResponseTypeMiddeware([
		"text/html",
		INITIATIVE_TYPE,
		"application/atom+xml"
	].map(MediaType), [
		"image/*"
	].map(MediaType)),
	next(function*(req, res, next) {
	var type = res.contentType
	var initiative = req.initiative

	if (type.type == "image") {
		var image = yield imagesDb.read(sql`
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

			res.send(serializeApiInitiative(
				initiative,
				initiative.external ? null : yield countSignaturesById(initiative.uuid)
			))
			break

		case "application/atom+xml":
			var events = yield searchInitiativeEvents(initiative)
			res.setHeader("Content-Type", type)
			res.render("initiatives/atom.jsx", {events: events})
			break

		default: exports.read(req, res, next)
	}
}))

exports.read = next(function*(req, res) {
	var user = req.user
	var initiative = req.initiative
	var thank = false
	var thankAgain = false
	var signature
	var newSignatureToken = req.flash("signatureToken")
	var isAuthor = user && initiative.user_id == user.id

	var textLanguage = (
		isAuthor && req.query.language ||
		initiative.phase != "edit" && req.query.language ||
		initiative.language
	)

	if (initiative.phase == "sign") if (newSignatureToken) {
		signature = yield signaturesDb.read(sql`
			SELECT * FROM initiative_signatures
			WHERE initiative_uuid = ${initiative.uuid}
			AND token = ${Buffer.from(newSignatureToken, "hex")}
		`)

		thank = !!signature
		thankAgain = signature && signature.oversigned > 0
	}
	else if (user) signature = yield signaturesDb.read(sql`
		SELECT * FROM initiative_signatures
		WHERE initiative_uuid = ${initiative.uuid}
		AND country = ${user.country}
		AND personal_id = ${user.personal_id}
	`)

	var subscriberCounts = yield sqlite(sql`
		SELECT
			SUM(initiative_uuid IS NULL) AS "all",
			SUM(initiative_uuid IS NOT NULL) AS initiative

		FROM initiative_subscriptions
		WHERE confirmed_at IS NOT NULL AND (
			initiative_uuid IS NULL OR
			initiative_uuid = ${initiative.uuid}
		)
	`).then(_.first)

	var comments = yield searchInitiativeComments(initiative.uuid)
	var events = yield searchInitiativeEvents(initiative)

	var subscription = user && user.email && user.email_confirmed_at
		? yield subscriptionsDb.read(sql`
			SELECT * FROM initiative_subscriptions
			WHERE initiative_uuid = ${initiative.uuid}
			AND email = ${user.email}
			LIMIT 1
		`)
		: null

	var files = yield filesDb.search(sql`
		SELECT id, name, title, content_type, length(content) AS size
		FROM initiative_files
		WHERE initiative_uuid = ${initiative.uuid}
		AND event_id IS NULL
	`)

	var signatureCount = yield countSignaturesById(initiative.uuid)

	var image = yield imagesDb.read(sql`
		SELECT initiative_uuid, type, author_name, author_url
		FROM initiative_images
		WHERE initiative_uuid = ${initiative.uuid}
	`)

	var text = yield textsDb.read(sql`
		SELECT text.* FROM initiative_texts AS text
		LEFT JOIN initiative_text_signatures AS sig
		ON sig.text_id = text.id AND sig.signed AND sig.timestamped
		WHERE text.initiative_uuid = ${initiative.uuid}
		AND text.language = ${textLanguage}

		${isAuthor ? sql`` : sql`AND (
			sig.id IS NOT NULL OR
			text.language = ${initiative.language}
		)`}

		ORDER BY text.id DESC
		LIMIT 1
	`)

	if (text == null && initiative.language != textLanguage && !isAuthor)
		return void res.redirect(307, req.baseUrl + req.path)

	if (text) initiative.title = text.title

	if (req.originalUrl.endsWith(".html")) {
		var html = (
			initiative.text ||
			text && Initiative.renderForParliament(text)
		)

		if (html) return void res.send(html)
		else throw new HttpError(404, "No Text Yet")
	}

	var translations = isAuthor ? _.indexBy(yield textsDb.search(sql`
		SELECT language, id
		FROM initiative_texts

		WHERE id IN (
			SELECT MAX(id) FROM initiative_texts
			WHERE initiative_uuid = ${initiative.uuid}
			AND language != ${initiative.language}
			GROUP BY language
		)
	`), "language") : EMPTY

	var signedTranslations = _.indexBy(yield textsDb.search(sql`
		SELECT language, id
		FROM initiative_texts

		WHERE id IN (
			SELECT MAX(text.id) FROM initiative_texts AS text
			JOIN initiative_text_signatures AS sig
			ON sig.text_id = text.id AND sig.signed AND sig.timestamped
			WHERE text.initiative_uuid = ${initiative.uuid}
			AND text.language != ${initiative.language}
			GROUP BY text.language
		)
	`), "language")

	res.render("initiatives/read_page.jsx", {
		thank: thank,
		thankAgain: thankAgain,
		signature: !signature || signature.hidden ? null : signature,
		subscription: subscription,
		subscriberCounts: subscriberCounts,
		signatureCount: signatureCount,
		text: text,
		textLanguage: textLanguage,
		translations: translations,
		signedTranslations: signedTranslations,
		image: image,
		files: files,
		comments: comments,
		events: events
	})
})

exports.router.put("/:id", next(function*(req, res) {
	var user = req.user
	if (user == null) throw new HttpError(401)

	if (req.body.visibility === "public") {
		yield updateInitiativeToPublished(req, res)
	}
	else if (req.body.status === "voting") {
		yield updateInitiativePhaseToSign(req, res)
	}
	else if (req.body.status === "followUp") {
		yield updateInitiativePhaseToParliament(req, res)
	}
	else if (isInitiativeUpdate(req.body)) {
		var initiative = req.initiative

		if (initiative.user_id != user.id)
			throw new HttpError(403, "No Permission to Edit")

		var attrs = parseInitiative(initiative, req.body)
		yield initiativesDb.update(initiative.uuid, attrs)
		res.flash("notice", req.t("INITIATIVE_INFO_UPDATED"))
		res.redirect(303, req.headers.referer || req.baseUrl + req.url)
	}
	else throw new HttpError(422, "Invalid Attribute")
}))

exports.router.delete("/:id", next(function*(req, res) {
	var user = req.user
	if (user == null) throw new HttpError(401)

	var initiative = req.initiative

	if (initiative.user_id != user.id)
		throw new HttpError(403, "No Permission to Delete")
	if (initiative.phase != "edit")
		throw new HttpError(405, "Can Only Delete Discussions")

	if (!initiative.published_at) yield commentsDb.execute(sql`
		DELETE FROM comments
		WHERE initiative_uuid = ${initiative.uuid}
	`)

	try { yield initiativesDb.delete(initiative.uuid) }
	catch (ex) {
		if (ex instanceof SqliteError && ex.code == "constraint") {
			res.flash("notice", req.t("INITIATIVE_CANNOT_BE_DELETED_HAS_COMMENTS"))
			res.redirect(303, req.baseUrl + req.path)
			return
		}
		else throw ex
	}

	res.flash("notice", req.t("INITIATIVE_DELETED"))
	res.redirect(303, req.baseUrl)
}))

exports.router.get("/:id/edit", next(function*(req, res) {
	var user = req.user
	if (user == null) throw new HttpError(401)

	var initiative = req.initiative

	if (!(user && initiative.user_id == user.id))
		throw new HttpError(403, "No Permission to Edit")

	var text = yield textsDb.read(sql`
		SELECT * FROM initiative_texts
		WHERE initiative_uuid = ${initiative.uuid}
		AND language = ${req.query.language || initiative.language}
		ORDER BY created_at DESC
		LIMIT 1
	`)

	var path = req.baseUrl + "/" + initiative.uuid + "/texts"
	if (text) res.redirect(path + "/" + text.id)
	else res.redirect(path + "/new?language=" + initiative.language)
}))

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

function* searchInitiativesEvents(initiatives) {
	var events = yield eventsDb.search(sql`
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

	return flatten(initiatives.map(function(initiative) {
		var events = eventsByInitiativeUuid[initiative.uuid] || EMPTY_ARR
		var sentToParliamentAt = initiative.sent_to_parliament_at
		var finishedInParliamentAt = initiative.finished_in_parliament_at
		var sentToGovernmentAt = initiative.sent_to_government_at
		var finishedInGovernmentAt = initiative.finished_in_government_at

		return concat(
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

function* searchInitiativeComments(initiativeUuid) {
	var comments = yield commentsDb.search(sql`
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
	var user = req.user
	var initiative = req.initiative
	var tmpl = "initiatives/update_for_publish_page.jsx"

	if (!(initiative.user_id == user.id && initiative.phase == "edit"))
		throw new HttpError(403, "No Permission to Edit")

	if (!(yield textsDb.read(sql`
		SELECT id FROM initiative_texts
		WHERE initiative_uuid = ${initiative.uuid}
		LIMIT 1
	`))) throw new HttpError(422, "No Text")

	if (req.body.endsAt == null) return void res.render(tmpl, {
		attrs: {endsAt: initiative.discussion_ends_at}
	})

	let endsAt = DateFns.endOfDay(Time.parseDate(req.body.endsAt))

	if (!Initiative.isDeadlineOk(initiative.published_at || new Date, endsAt)) {
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

	yield initiativesDb.update(initiative.uuid, {
		published_at: initiative.published_at || new Date,
		discussion_ends_at: endsAt,
		discussion_end_email_sent_at: endsAt > new Date ? null : emailSentAt
	})

	res.flash("notice", initiative.published_at == null
		? req.t("PUBLISHED_INITIATIVE")
		: req.t("INITIATIVE_DISCUSSION_DEADLINE_UPDATED")
	)

	res.redirect(303, req.baseUrl + "/" + initiative.uuid)
}

function* updateInitiativePhaseToSign(req, res) {
	var user = req.user
	var initiative = req.initiative
	var tmpl = "initiatives/update_for_voting_page.jsx"

	if (initiative.user_id != user.id)
		throw new HttpError(403, "No Permission to Edit")

	if (!(
		Initiative.canPropose(new Date, initiative, user) ||
		Initiative.canUpdateSignDeadline(initiative, user)
	)) throw new HttpError(403, "Cannot Update to Sign Phase")

	res.locals.texts = _.indexBy(yield textsDb.search(sql`
		SELECT title, language, created_at
		FROM initiative_texts
		WHERE id IN (
			SELECT MAX(id) FROM initiative_texts
			WHERE initiative_uuid = ${initiative.uuid}
			GROUP BY language
		)
	`), "language")

	if (req.body.endsAt == null) return void res.render(tmpl, {
		attrs: {endsAt: initiative.signing_started_at}
	})

	var lang = req.body.language
	let endsAt = DateFns.endOfDay(Time.parseDate(req.body.endsAt))
	var attrs = {endsAt: endsAt}

	if (
		!Initiative.isDeadlineOk(initiative.signing_started_at || new Date, endsAt)
	) {
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
		var text = yield textsDb.read(sql`
			SELECT * FROM initiative_texts
			WHERE initiative_uuid = ${initiative.uuid}
			AND language = ${lang}
			ORDER BY created_at DESC
			LIMIT 1
		`)

		if (text == null) throw new HttpError(422, "No Text")
		var html = Initiative.renderForParliament(text)

		attrs.text = html
		attrs.text_type = new MediaType("text/html")
		attrs.text_sha256 = sha256(html)
		attrs.title = text.title
		attrs.language = lang
	}

	yield initiativesDb.update(initiative, attrs)

	if (initiative.phase == "edit") {
		var message = yield messagesDb.create({
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

			yield subscriptionsDb.searchConfirmedByInitiativeIdForOfficial(
				initiative.uuid
			)
		)
	}

	res.flash("notice", initiative.phase == "edit"
		? req.t("INITIATIVE_SIGN_PHASE_UPDATED")
		: req.t("INITIATIVE_SIGNING_DEADLINE_UPDATED")
	)

	res.redirect(303, req.baseUrl + "/" + initiative.uuid)
}

function* updateInitiativePhaseToParliament(req, res) {
	var user = req.user
	var initiative = req.initiative
	var uuid = initiative.uuid
	var citizenosSignatureCount = yield countCitizenOsSignaturesById(uuid)
	var undersignedSignatureCount = yield countUndersignedSignaturesById(uuid)
	var signatureCount = citizenosSignatureCount + undersignedSignatureCount
	var tmpl = "initiatives/update_for_parliament_page.jsx"

	if (initiative.user_id != user.id)
		throw new HttpError(403, "No Permission to Edit")

	if (initiative.destination != "parliament")
		throw new HttpError(403, "Cannot Send Local Initiative to Parliament")

	if (!Initiative.canSendToParliament(initiative, user, signatureCount))
		throw new HttpError(403, "Cannot Send to Parliament")

	if (initiative.language != "et") {
		var estonian = yield textsDb.read(sql`
			SELECT text.id
			FROM initiative_texts AS text
			JOIN initiative_text_signatures AS sig
			ON sig.text_id = text.id AND sig.signed AND sig.timestamped
			WHERE text.initiative_uuid = ${initiative.uuid}
			AND language = 'et'
			ORDER BY text.id DESC
			LIMIT 1
		`)

		if (estonian == null)
			throw new HttpError(403, "No Signed Estonian Translation")
	}

	var attrs = {
		status: req.body.status,
		contact: req.body.contact || EMPTY_CONTACT
	}

	if (req.body.contact == null) return void res.render(tmpl, {attrs: attrs})

	initiative = yield initiativesDb.update(initiative, {
		phase: "parliament",
		sent_to_parliament_at: new Date,
		parliament_token: Crypto.randomBytes(12)
	})

	var initiativeUrl = `${Config.url}/initiatives/${initiative.uuid}`
	var parliamentToken = initiative.parliament_token.toString("hex")

	var undersignedSignaturesUrl =
		`${initiativeUrl}/signatures.asice?` +
		Qs.stringify({"parliament-token": parliamentToken})

	var citizenosSignaturesUrl =
		`${initiativeUrl}/signatures.zip?` +
		Qs.stringify({type: "citizenos", "parliament-token": parliamentToken})

	yield sendEmail({
		to: Config.parliamentEmail,

		subject: t("EMAIL_INITIATIVE_TO_PARLIAMENT_TITLE", {
			initiativeTitle: initiative.title
		}),

		text: renderEmail(
			"et",
			citizenosSignatureCount > 0
			? "EMAIL_INITIATIVE_TO_PARLIAMENT_WITH_CITIZENOS_SIGNATURES_BODY"
			: "EMAIL_INITIATIVE_TO_PARLIAMENT_BODY", {
			initiativeTitle: initiative.title,
			initiativeUrl: initiativeUrl,
			initiativeUuid: initiative.uuid,

			signatureCount: signatureCount,
			undersignedSignaturesUrl: undersignedSignaturesUrl,
			citizenosSignaturesUrl: citizenosSignaturesUrl,

			authorName: attrs.contact.name,
			authorEmail: attrs.contact.email,
			authorPhone: attrs.contact.phone,
		})
	})

	var message = yield messagesDb.create({
		initiative_uuid: initiative.uuid,
		origin: "status",
		created_at: new Date,
		updated_at: new Date,

		title: t("SENT_TO_PARLIAMENT_MESSAGE_TITLE", {
			initiativeTitle: initiative.title
		}),

		text: renderEmail("et", "SENT_TO_PARLIAMENT_MESSAGE_BODY", {
			authorName: attrs.contact.name,
			initiativeTitle: initiative.title,
			initiativeUrl: `${Config.url}/initiatives/${initiative.uuid}`,
			signatureCount: signatureCount
		})
	})

	yield Subscription.send(
		message,
		yield subscriptionsDb.searchConfirmedByInitiativeIdForOfficial(initiative.uuid)
	)

	res.flash("notice", req.t("SENT_TO_PARLIAMENT_CONTENT"))
	res.redirect(303, req.baseUrl + "/" + initiative.uuid)
}

function parseInitiative(initiative, obj) {
	var attrs = {}

	if ("destination" in obj && initiative.phase == "edit") {
		var dest = obj.destination || null

		if (!(dest == null || dest == "parliament" || dest in LOCAL_GOVERNMENTS))
			throw new HttpError(422, "Destination Invalid")

		attrs.destination = dest
	}

	if ("author_name" in obj) attrs.author_name = String(obj.author_name).trim()
	if ("author_url" in obj) attrs.author_url = String(obj.author_url).trim()
	if ("url" in obj) attrs.url = String(obj.url).trim()
	if ("notes" in obj) attrs.notes = String(obj.notes).trim()

	if ("community_url" in obj)
		attrs.community_url = String(obj.community_url).trim()

	if ("organizations" in obj) attrs.organizations =
		obj.organizations.map(parseOrganization).filter(isOrganizationPresent)

	if ("meetings" in obj) attrs.meetings =
		obj.meetings.map(parseMeeting).filter(isMeetingPresent)

	if ("media_urls" in obj) attrs.media_urls =
		obj.media_urls.map(String).map(trim).filter(Boolean)

	if ("government_change_urls" in obj) attrs.government_change_urls =
		obj.government_change_urls.map(String).map(trim).filter(Boolean)

	if ("public_change_urls" in obj) attrs.public_change_urls =
		obj.public_change_urls.map(String).map(trim).filter(Boolean)

	return attrs
}

function* countSignaturesByIdsAndTime(uuids, from) {
	return _.mapValues(_.indexBy(yield sqlite(sql`
		SELECT initiative_uuid AS uuid, COUNT(*) as count
		FROM initiative_signatures
		WHERE created_at >= ${from}
		AND initiative_uuid IN ${sql.in(uuids)}
		GROUP BY initiative_uuid
	`), "uuid"), _.property("count"))
}

function serializeApiInitiative(initiative, signatureCount) {
	return {
		id: initiative.uuid,
		for: initiative.destination,
		title: initiative.title,
		phase: initiative.phase,
		signatureCount: signatureCount
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

function isValidDestination(dest) {
	return dest == "parliament" || dest in LOCAL_GOVERNMENTS
}

function isApiRequest(req) { return req.accept[0].name == INITIATIVE_TYPE.name }
function isOrganizationPresent(org) { return org.name || org.url }
function isMeetingPresent(org) { return org.date || org.url }
