var _ = require("root/lib/underscore")
var DateFns = require("date-fns")
var Config = require("root/config")
var job = require("root/jobs/initiative_end_email_job")
var newUuid = require("uuid/v4")
var newUser = require("root/test/citizenos_fixtures").newUser
var newVote = require("root/test/citizenos_fixtures").newVote
var newSignature = require("root/test/citizenos_fixtures").newSignature
var createUser = require("root/test/citizenos_fixtures").createUser
var createVote = require("root/test/citizenos_fixtures").createVote
var createOptions = require("root/test/citizenos_fixtures").createOptions
var createSignature = require("root/test/citizenos_fixtures").createSignature
var pseudoHex = require("root/lib/crypto").pseudoHex
var cosDb = require("root").cosDb
var sql = require("sqlate")
var PARTNER_ID = Config.apiPartnerId
var SIGS_REQUIRED = Config.votesRequired

describe("InitiativeEndEmailJob", function() {
	require("root/test/mitm")()
	require("root/test/db")()
	require("root/test/email")()
	require("root/test/time")(new Date(2015, 5, 18, 13, 37, 42))
	beforeEach(require("root/test/mitm").router)

	beforeEach(function*() {
		this.user = yield createUser(newUser())

		this.partner = yield cosDb("Partners").insert({
			id: PARTNER_ID,
			website: "http://example.com",
			redirectUriRegexp: "",
			createdAt: new Date,
			updatedAt: new Date
		}).returning("*").then(_.first)
	})
	
	describe("when in discussion", function() {
		it("must email when discussion has ended", function*() {
			yield createTopic({creatorId: this.user.id, endsAt: new Date})
			yield job()
			this.emails.length.must.equal(1)
			this.emails[0].envelope.to.must.eql([this.user.email])
			var body = String(this.emails[0].message)
			body.must.not.include("undefined")
		})

		it("must email when discussion ended 6 months ago", function*() {
			yield createTopic({
				creatorId: this.user.id,
				endsAt: DateFns.addMonths(new Date, -6)
			})

			yield job()
			this.emails.length.must.equal(1)
		})

		it("must not email when discussion ended more than 6 months ago",
			function*() {
			yield createTopic({
				creatorId: this.user.id,
				endsAt: DateFns.addSeconds(DateFns.addMonths(new Date, -6), -1)
			})

			yield job()
			this.emails.length.must.equal(0)
		})

		it("must not email when discussion not ended", function*() {
			yield createTopic({
				creatorId: this.user.id,
				endsAt: DateFns.addSeconds(new Date, 1)
			})

			yield job()
			this.emails.must.be.empty()
		})

		it("must not email if user email not set", function*() {
			yield cosDb.query(sql`UPDATE "Users" SET email = NULL`)
			yield createTopic({creatorId: this.user.id, endsAt: new Date})
			yield job()
			this.emails.must.be.empty()
		})

		it("must not email if user email not verified", function*() {
			yield cosDb.query(sql`UPDATE "Users" SET "emailIsVerified" = false`)
			yield createTopic({creatorId: this.user.id, endsAt: new Date})
			yield job()
			this.emails.must.be.empty()
		})

		it("must not email if not public", function*() {
			yield createTopic({
				creatorId: this.user.id,
				endsAt: new Date,
				visibility: "private"
			})

			yield job()
			this.emails.must.be.empty()
		})

		it("must not email if vote already created", function*() {
			yield createTopic({
				creatorId: this.user.id,
				endsAt: new Date,
				status: "voting"
			})

			yield job()
			this.emails.must.be.empty()
		})

		// Safety net for when running development on a shared server.
		it("must not email about other partners", function*() {
			var partner = yield cosDb("Partners").insert({
				id: newUuid(),
				website: "http://example.com",
				redirectUriRegexp: "",
				createdAt: new Date,
				updatedAt: new Date
			}).returning("*").then(_.first)

			yield createTopic({
				creatorId: this.user.id,
				sourcePartnerId: partner.id,
				endsAt: new Date
			})

			yield job()
			this.emails.must.be.empty()
		})

		it("must not email twice", function*() {
			yield createTopic({creatorId: this.user.id, endsAt: new Date})

			yield job()
			this.emails.length.must.equal(1)

			yield job()
			this.emails.length.must.equal(1)
		})
	})

	describe("when in signing", function() {
		it("must email when signing has ended and initiative successful",
			function*() {
			var topic = yield createTopic({creatorId: this.user.id, status: "voting"})
			yield createVote(topic, newVote({endsAt: new Date}))
			yield createSignatures(topic, SIGS_REQUIRED)

			yield job()
			this.emails.length.must.equal(1)
			this.emails[0].envelope.to.must.eql([this.user.email])
			var body = String(this.emails[0].message)
			body.must.not.include("undefined")
		})

		it("must email when signing has ended and initiative incomplete",
			function*() {
			var topic = yield createTopic({creatorId: this.user.id, status: "voting"})
			yield createVote(topic, newVote({endsAt: new Date}))
			yield createSignatures(topic, SIGS_REQUIRED - 1)

			yield job()
			this.emails.length.must.equal(1)
			this.emails[0].envelope.to.must.eql([this.user.email])
			var body = String(this.emails[0].message)
			body.must.not.include("undefined")
		})

		it("must email when signing ended 6 months ago", function*() {
			var topic = yield createTopic({creatorId: this.user.id, status: "voting"})

			yield createVote(topic, newVote({
				endsAt: DateFns.addMonths(new Date, -6)
			}))

			yield createSignatures(topic, SIGS_REQUIRED)
			yield job()
			this.emails.length.must.equal(1)
		})

		it("must not email when signing ended more than 6 months ago", function*() {
			var topic = yield createTopic({creatorId: this.user.id, status: "voting"})

			yield createVote(topic, newVote({
				endsAt: DateFns.addSeconds(DateFns.addMonths(new Date, -6), -1)
			}))

			yield createSignatures(topic, SIGS_REQUIRED)
			yield job()
			this.emails.length.must.equal(0)
		})

		it("must not email when signing not ended", function*() {
			var topic = yield createTopic({creatorId: this.user.id, status: "voting"})
			yield createVote(topic, newVote({endsAt: DateFns.addSeconds(new Date, 1)}))
			yield job()
			this.emails.must.be.empty()
		})

		it("must not email if user email not set", function*() {
			yield cosDb.query(sql`UPDATE "Users" SET email = NULL`)
			var topic = yield createTopic({creatorId: this.user.id, status: "voting"})
			yield createVote(topic, newVote({endsAt: new Date}))
			yield job()
			this.emails.must.be.empty()
		})

		it("must not email if user email not verified", function*() {
			yield cosDb.query(sql`UPDATE "Users" SET "emailIsVerified" = false`)
			var topic = yield createTopic({creatorId: this.user.id, status: "voting"})
			yield createVote(topic, newVote({endsAt: new Date}))
			yield job()
			this.emails.must.be.empty()
		})

		it("must not email if not public", function*() {
			var topic = yield createTopic({
				creatorId: this.user.id,
				visibility: "private",
				status: "voting"
			})

			yield createVote(topic, newVote({endsAt: new Date}))
			yield job()
			this.emails.must.be.empty()
		})
		//
		// Safety net for when running development on a shared server.
		it("must not email about other partners", function*() {
			var partner = yield cosDb("Partners").insert({
				id: newUuid(),
				website: "http://example.com",
				redirectUriRegexp: "",
				createdAt: new Date,
				updatedAt: new Date
			}).returning("*").then(_.first)

			var topic = yield createTopic({
				creatorId: this.user.id,
				sourcePartnerId: partner.id,
				status: "voting"
			})

			yield createVote(topic, newVote({endsAt: new Date}))
			yield job()
			this.emails.must.be.empty()
		})

		it("must not email twice", function*() {
			var topic = yield createTopic({creatorId: this.user.id, status: "voting"})
			yield createVote(topic, newVote({endsAt: new Date}))

			yield job()
			this.emails.length.must.equal(1)

			yield job()
			this.emails.length.must.equal(1)
		})
	})
})

function createTopic(attrs) {
	return cosDb("Topics").insert(_.assign({
		id: newUuid(),
		title: "For the win",
		description: "Please sign.",
		status: "inProgress",
		visibility: "public",
		createdAt: new Date(2015, 0, 1),
		updatedAt: new Date(2015, 0, 1),
		tokenJoin: pseudoHex(4),
		padUrl: "/etherpad",
		sourcePartnerId: PARTNER_ID
	}, attrs)).returning("*").then(_.first)
}

function* createSignatures(topic, n) {
	var vote = yield createVote(topic, newVote())
	var yesAndNo = yield createOptions(vote)
	var users = yield _.times(n, _.compose(createUser, newUser))

	return createSignature(users.map((user) => newSignature({
		userId: user.id,
		voteId: vote.id,
		optionId: yesAndNo[0]
	})))
}
