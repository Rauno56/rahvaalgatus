var Http = require("http")
var Web = require("root/bin/web")
var request = require("root/lib/request")
var fetchDefaults = require("fetch-defaults")
var {fetchSession} = require("./fixtures")
var {wait} = require("root/lib/promise")

exports = module.exports = function() {
	before(exports.listen)
	after(exports.close)
}

exports.listen = function*() {
	this.server = new Http.Server(Web)
	this.server.listen(0, "127.0.0.1")

	yield wait(this.server, "listening")
	this.url = "http://localhost:" + this.server.address().port

	var webRequest = request
	webRequest = fetchDefaults(webRequest, this.url)
	webRequest = fetchSession(webRequest)
	this.request = webRequest
}

exports.close = function(done) {
	this.server.close(done)
}
