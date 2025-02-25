var _ = require("root/lib/underscore")
var Config = require("root").config
var Path = require("path")
var {Router} = require("express")
var HttpError = require("standard-http-error")
var SqliteError = require("root/lib/sqlite_error")
var Subscription = require("root/lib/subscription")
var next = require("co-next")
var sql = require("sqlate")
var commentsDb = require("root/db/comments_db")
var {isAdmin} = require("root/lib/user")
var subscriptionsDb = require("root/db/initiative_subscriptions_db")
var renderEmail = require("root/lib/i18n").email.bind(null, "et")
var MAX_TITLE_LENGTH = 140
var MAX_TEXT_LENGTH = 3000
exports.MAX_TITLE_LENGTH = MAX_TITLE_LENGTH
exports.MAX_TEXT_LENGTH = MAX_TEXT_LENGTH
exports.getCommentAuthorName = getCommentAuthorName
exports.router = Router({mergeParams: true})

var CONSTRAINT_ERRORS = {
	comments_title_present: [
		"INITIATIVE_COMMENT_TITLE_LENGTH_ERROR", {max: MAX_TITLE_LENGTH}
	],

	comments_title_length: [
		"INITIATIVE_COMMENT_TITLE_LENGTH_ERROR", {max: MAX_TITLE_LENGTH}
	],

	comments_text_length: [
		"INITIATIVE_COMMENT_TEXT_LENGTH_ERROR", {max: MAX_TEXT_LENGTH}
	]
}

exports.router.get("/new", function(req, res) {
	var {user} = req
	if (user == null) throw new HttpError(401)

	res.render("initiatives/comments/create_page.jsx")
})

exports.router.post("/", next(function*(req, res) {
	var {t} = req
	var {user} = req
	if (user == null) throw new HttpError(401)

	var {initiative} = req
	var userEmail = user.email || ""
	var parse = isAdmin(user) ? parseCommentAsAdmin : parseComment

	var attrs = _.assign(parse(req.body), {
		initiative_uuid: initiative.uuid,
		user_id: user.id,
		user_uuid: _.serializeUuid(user.uuid),
		created_at: new Date,
		updated_at: new Date
	})

	try {
		var comment = commentsDb.create(attrs)
		var initiativeUrl = `${Config.url}/initiatives/${initiative.uuid}`
		var subscribe = _.parseTrilean(req.body.subscribe)

		if (subscribe != null && user.email) {
			var subscription = subscriptionsDb.read(sql`
				SELECT * FROM initiative_subscriptions
				WHERE (initiative_uuid, email) = (${initiative.uuid}, ${userEmail})
			`)

			if (subscription) subscriptionsDb.update(subscription, {
				comment_interest: subscribe,
				updated_at: new Date,
				confirmed_at: new Date
			})
			else if (subscribe) subscriptionsDb.create({
				email: user.email,
				initiative_uuid: initiative.uuid,
				event_interest: false,
				comment_interest: true,
				created_at: new Date,
				created_ip: req.ip,
				updated_at: new Date,
				confirmed_at: new Date
			})
		}

		if (initiative.published_at) {
			var subs = subscriptionsDb.searchConfirmedByInitiativeIdWith(
				initiative.uuid,
				sql`comment_interest AND email != ${userEmail}`
			)

			yield Subscription.send({
				title: req.t("EMAIL_INITIATIVE_COMMENT_TITLE", {
					initiativeTitle: initiative.title,
				}),

				text: renderEmail("EMAIL_INITIATIVE_COMMENT_BODY", {
					initiativeTitle: initiative.title,
					initiativeUrl: initiativeUrl,
					userName: getCommentAuthorName(t, comment, user),
					commentTitle: comment.title.replace(/\r?\n/g, " "),
					commentText: _.quoteEmail(comment.text),
					commentUrl: initiativeUrl + "#comment-" + comment.id
				})
			}, subs)
		}

		var url = req.baseUrl + "/" + comment.id
		if (req.body.referrer) url = req.body.referrer + "#comment-" + comment.id
		res.redirect(303, url)
	}
	catch (err) {
		if (err instanceof SqliteError && err.code == "constraint") {
			res.status(422)
			res.flash("error", req.t.apply(null, CONSTRAINT_ERRORS[err.constraint]))

			res.render("initiatives/comments/create_page.jsx", {
				referrer: req.body.referrer,
				newComment: attrs
			})
		}
		else throw err
	}
}))

exports.router.use("/:commentId", function(req, res, next) {
	var id = req.params.commentId
	var {initiative} = req
	var baseUrl = Path.dirname(req.baseUrl)

	var comment = commentsDb.read(sql`
		SELECT comment.*, user.name AS user_name
		FROM comments AS comment

		LEFT JOIN users AS user
		ON comment.user_id = user.id
		AND comment.anonymized_at IS NULL
		AND NOT comment.as_admin

		WHERE (comment.id = ${id} OR comment.uuid = ${id})
		AND comment.initiative_uuid = ${initiative.uuid}
	`)

	if (comment == null)
		throw new HttpError(404)
	if (comment.uuid == id)
		return void res.redirect(308, baseUrl + "/" + comment.id)

	req.comment = comment
	next()
})

exports.router.get("/:commentId", function(req, res) {
	var {comment} = req

	if (comment.parent_id)
		return void res.redirect(302, req.baseUrl + "/" + comment.parent_id)

	renderComment(req, res)
})

exports.router.delete("/:commentId", function(req, res) {
	var {user} = req
	if (user == null) throw new HttpError(401)

	var {comment} = req
	if (comment.anonymized_at) throw new HttpError(405, "Already Anonymized")
	if (comment.user_id != user.id) throw new HttpError(403, "Not Author")
	if (comment.parent_id) throw new HttpError(405, "Cannot Delete Replies")

	commentsDb.update(comment, {anonymized_at: new Date})

	res.flash("notice", req.t("COMMENT_ANONYMIZED"))
	res.redirect(303, req.baseUrl + "/" + comment.id)
})

exports.router.post("/:commentId/replies", next(function*(req, res) {
	var {t} = req
	var {user} = req
	if (user == null) throw new HttpError(401)

	var {initiative} = req
	var parent = req.comment
	if (parent.parent_id) throw new HttpError(405)

	var parse = isAdmin(user) ? parseCommentAsAdmin : parseComment
	var attrs = _.assign(parse(req.body), {
		initiative_uuid: parent.initiative_uuid,
		parent_id: parent.id,
		user_id: user.id,
		user_uuid: _.serializeUuid(user.uuid),
		created_at: new Date,
		updated_at: new Date,
		title: ""
	})

	try {
		var reply = commentsDb.create(attrs)
		var initiativeUrl = `${Config.url}/initiatives/${initiative.uuid}`
		var userEmail = user.email || ""

		if (initiative.published_at) {
			var subs = subscriptionsDb.searchConfirmedByInitiativeIdWith(
				initiative.uuid,
				sql`comment_interest AND email != ${userEmail}`
			)

			yield Subscription.send({
				title: req.t("EMAIL_INITIATIVE_COMMENT_REPLY_TITLE", {
					initiativeTitle: initiative.title,
				}),

				text: renderEmail("EMAIL_INITIATIVE_COMMENT_REPLY_BODY", {
					initiativeTitle: initiative.title,
					initiativeUrl: initiativeUrl,
					userName: getCommentAuthorName(t, reply, user),
					commentText: _.quoteEmail(reply.text),
					commentUrl: initiativeUrl + "#comment-" + reply.id
				})
			}, subs)
		}

		var url = req.body.referrer || req.baseUrl + "/" + parent.id
		res.redirect(303, url + "#comment-" + reply.id)
	}
	catch (err) {
		if (err instanceof SqliteError && err.code == "constraint") {
			res.status(422)
			res.flash("error", req.t.apply(null, CONSTRAINT_ERRORS[err.constraint]))
			res.locals.newComment = attrs
			renderComment(req, res)
		}
		else throw err
	}
}))

function renderComment(req, res) {
	var {comment} = req

	comment.replies = commentsDb.search(sql`
		SELECT comment.*, user.name AS user_name
		FROM comments AS comment

		LEFT JOIN users AS user
		ON comment.user_id = user.id
		AND comment.anonymized_at IS NULL
		AND NOT comment.as_admin

		WHERE parent_id = ${comment.id}
	`)

	res.render("initiatives/comments/read_page.jsx", {comment: comment})
}

function parseComment(obj) {
	return {
		title: String(obj.title || ""),
		text: normalizeNewlines(String(obj.text || ""))
	}
}

function parseCommentAsAdmin(obj) {
	var attrs = parseComment(obj)
	attrs.as_admin = obj.persona == "admin"
	return attrs
}

function getCommentAuthorName(t, comment, user) {
	if (comment.as_admin) return t("COMMENT_AUTHOR_ADMIN")
	if (comment.anonymized_at) return t("COMMENT_AUTHOR_HIDDEN")
	return user && user.name || comment.user_name
}

function normalizeNewlines(text) { return text.replace(/\r\n/g, "\n") }
