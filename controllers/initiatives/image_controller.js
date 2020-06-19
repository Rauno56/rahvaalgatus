var _ = require("root/lib/underscore")
var Path = require("path")
var Router = require("express").Router
var HttpError = require("standard-http-error")
var Image = require("root/lib/image")
var imagesDb = require("root/db/initiative_images_db")
var next = require("co-next")
var sql = require("sqlate")
var MEGABYTE = Math.pow(2, 20)

exports.router = Router({mergeParams: true})

exports.router.use(next(function*(req, _res, next) {
	var user = req.user
	if (user == null) throw new HttpError(401)

	var initiative = req.initiative
	if (user && initiative.user_id == user.id);
	else throw new HttpError(403, "No Permission to Edit")

	req.image = yield imagesDb.read(sql`
		SELECT initiative_uuid
		FROM initiative_images
		WHERE initiative_uuid = ${initiative.uuid}
	`)

	next()
}))

exports.router.put("/", next(function*(req, res) {
	var initiative = req.initiative
	var image = req.image
	var attrs = parse(req.body)
	var imageFile = req.files.image

  if (image == null && imageFile == null) return void respondWithError(
		"Image Missing",
		req.t("INITIATIVE_IMAGE_ERROR_IMAGE_MISSING")
	)

	if (imageFile && imageFile.size > 3 * MEGABYTE) return void respondWithError(
		"Image Larger Than 3MiB",
		req.t("INITIATIVE_IMAGE_ERROR_IMAGE_TOO_LARGE")
	)

	if (
		imageFile && (
			!isValidImageType(imageFile.mimetype) ||
			!isValidImageType(Image.identify(imageFile.buffer))
		)
	) return void respondWithError(
		"Invalid Image Format",
		req.t("INITIATIVE_IMAGE_ERROR_INVALID_FORMAT")
	)

	if (imageFile) {
		attrs.data = imageFile.buffer
		attrs.type = imageFile.mimetype
		attrs.preview = yield Image.resize(1200, 675, imageFile.buffer)
	}

	if (image) imagesDb.update(image, attrs)
	else yield imagesDb.create(_.assign(attrs, {
		initiative_uuid: initiative.uuid
	}))

	res.flash("notice", imageFile
		? req.t("INITIATIVE_IMAGE_UPLOADED")
		: req.t("INITIATIVE_IMAGE_AUTHOR_UPDATED")
	)

	res.redirect(303, Path.dirname(req.baseUrl))

	function respondWithError(statusMessage, err) {
		res.statusCode = 422
		res.statusMessage = statusMessage

		res.render("error_page.jsx", {
			title: req.t("INITIATIVE_IMAGE_ERROR_TITLE"),
			body: err
		})
	}
}))

exports.router.delete("/", next(function*(req, res) {
	if (req.image == null) throw new HttpError(404, "No Initiative Image")
	yield imagesDb.delete(req.image)
	res.flash("notice", "Pilt kustutatud.")
	res.redirect(303, Path.dirname(req.baseUrl))
}))

function isValidImageType(type) {
  switch (type) {
    case "image/png":
    case "image/jpeg": return true
    default: return false
  }
}

function parse(obj) {
	return _.pick(obj, ["author_name", "author_url"])
}
