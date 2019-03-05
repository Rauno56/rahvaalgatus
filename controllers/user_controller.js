var O = require("oolong")
var Router = require("express").Router
var HttpError = require("standard-http-error")
var isOk = require("root/lib/http").isOk
var catch400 = require("root/lib/fetch").catch.bind(null, 400)
var translateCitizenError = require("root/lib/citizenos_api").translateError
var parseCitizenInitiative = require("root/lib/citizenos_api").parseCitizenInitiative
var initiativesDb = require("root/db/initiatives_db")
var next = require("co-next")

exports.router = Router({mergeParams: true})

exports.router.get("/", next(read))

exports.router.put("/", next(function*(req, res, next) {
	var updated = yield req.cosApi("/api/users/self", {
		method: "PUT",
		json: {name: req.body.name, email: req.body.email}
	}).catch(catch400)

	if (isOk(updated)) {
		res.flash("notice", "Muudatused salvestatud.")
		res.redirect(303, req.baseUrl)
	}
	else {
		res.status(422)
		res.locals.error = translateCitizenError(req.t, updated.body)
		res.locals.attrs = req.body
		yield read(req, res, next)
	}
}))

function* read(req, res) {
	if (req.user == null) throw new HttpError(401)

	var path = "/api/users/self/topics?include[]=vote&include[]=event"
	var initiatives = req.cosApi(path)
	initiatives = yield initiatives.then(getRows)
	initiatives = initiatives.map(parseCitizenInitiative)

	var uuids = initiatives.map((i) => i.id)
	var dbInitiatives = yield initiativesDb.search(uuids, {create: true})

	res.render("user/read", {
		user: req.user,
		initiatives: initiatives,
		dbInitiatives: dbInitiatives,
		attrs: O.create(req.user, res.locals.attrs)
	})
}

function getRows(res) { return res.body.data.rows }
