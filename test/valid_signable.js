var _ = require("root/lib/underscore")
var Crypto = require("crypto")
var Xades = require("undersign/xades")
var Certificate = require("undersign/lib/certificate")
var newCertificate = require("root/test/fixtures").newCertificate

var xades = Xades.parse(String(new Xades(new Certificate(newCertificate({
	subject: {countryName: "EE"},
	issuer: {countryName: "EE"}
})), [])))

xades.setSignature(Buffer.from("foo"))

module.exports = function(attrs) {
	var createdAt = new Date

	var country = attrs && attrs.country || "EE"
	var personalId = attrs && attrs.personal_id || randomPersonalId()

	return _.assign({
		created_at: createdAt,
		updated_at: createdAt,
		country: country,
		personal_id: personalId,
		token: Crypto.randomBytes(12),
		method: "id-card",
		signed: false,
		timestamped: false,
		xades: xades,
		error: null
	}, attrs)
}

function randomPersonalId() {
	return _.padLeft(String(Math.floor(Math.random() * 1e11)), 11, "1")
}
