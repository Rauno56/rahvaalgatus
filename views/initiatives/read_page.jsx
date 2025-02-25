/** @jsx Jsx */
var _ = require("root/lib/underscore")
var Url = require("url")
var Jsx = require("j6pack")
var {Fragment} = Jsx
var Time = require("root/lib/time")
var DateFns = require("date-fns")
var InitiativePage = require("./initiative_page")
var Config = require("root").config
var I18n = require("root/lib/i18n")
var {Flash} = require("../page")
var {Form} = require("../page")
var Trix = require("root/lib/trix")
var Initiative = require("root/lib/initiative")
var {FormButton} = require("../page")
var {DonateForm} = require("../donations/create_page")
var {CommentView} = require("./comments/read_page")
var {CommentForm} = require("./comments/create_page")
var {ProgressView} = require("./initiative_page")
var {CoauthorInvitationForm} = require("./coauthor_invitation_page")
var {getRequiredSignatureCount} = require("root/lib/initiative")
var {isAdmin} = require("root/lib/user")
var {selected} = require("root/lib/css")
var {javascript} = require("root/lib/jsx")
var serializeInitiativeUrl = require("root/lib/initiative").initiativeUrl
var serializeImageUrl = require("root/lib/initiative").imageUrl
var {pathToSignature} =
	require("root/controllers/initiatives/signatures_controller")
var {confirm} = require("root/lib/jsx")
var linkify = require("root/lib/linkify")
var encode = encodeURIComponent
var {min} = Math
var {normalizeCitizenOsHtml} = require("root/lib/initiative")
var diffInDays = DateFns.differenceInCalendarDays
var {PHASES} = require("root/lib/initiative")
var HTTP_URL = /^https?:\/\//i
var EMPTY_ARR = Array.prototype
var EMPTY_ORG = {name: "", url: ""}
var EVENT_NOTIFICATIONS_SINCE = new Date(Config.eventNotificationsSince)
var SIGNABLE_TYPE = "application/vnd.rahvaalgatus.signable"
var ERR_TYPE = "application/vnd.rahvaalgatus.error+json"
var LOCAL_GOVERNMENTS = require("root/lib/local_governments")
var LANGUAGES = require("root").config.languages
var {SCHEMA} = require("root/controllers/initiatives_controller")
var IMAGE_SCHEMA =
	require("root/controllers/initiatives/image_controller").SCHEMA
exports = module.exports = ReadPage
exports.InitiativeDestinationSelectView = InitiativeDestinationSelectView
exports.SigningView = SigningView

var LOCAL_GOVERNMENTS_BY_COUNTY = _.mapValues(_.groupBy(
	_.toEntries(LOCAL_GOVERNMENTS),
	([_id, gov]) => gov.county
), (govs) => _.sortBy(govs, ([_id, gov]) => gov.name).map(([id, gov]) => [
	id,
	gov.name
]))

// Kollektiivse pöördumise (edaspidi käesolevas peatükis pöördumine) menetlusse
// võtmise otsustab Riigikogu juhatus 30 kalendripäeva jooksul kollektiivse
// pöördumise esitamisest arvates.
//
// https://www.riigiteataja.ee/akt/122122014013?leiaKehtiv#para152b9
var PARLIAMENT_ACCEPTANCE_DEADLINE_IN_DAYS = 30

// Komisjon arutab pöördumist kolme kuu jooksul ning teeb otsuse pöördumise
// kohta kuue kuu jooksul pöördumise menetlusse võtmisest arvates.
//
// https://www.riigiteataja.ee/akt/122122014013?leiaKehtiv#para152b12
var PARLIAMENT_PROCEEDINGS_DEADLINE_IN_MONTHS = 6

var UI_TRANSLATIONS = _.mapValues(I18n.STRINGS, function(lang) {
	return _.filterValues(lang, (_value, key) => key.indexOf("HWCRYPTO") >= 0)
})

var FILE_TYPE_ICONS = {
	"text/html": "ra-icon-html",
	"application/pdf": "ra-icon-pdf",
	"text/plain": "ra-icon-txt",
	"image/jpeg": "ra-icon-jpeg",
	"application/vnd.ms-powerpoint": "ra-icon-ppt",
	"application/vnd.ms-outlook": "ra-icon-msg",
	"application/vnd.etsi.asic-e+zip": "ra-icon-ddoc",
	"application/digidoc": "ra-icon-ddoc",
	"application/msword": "ra-icon-doc",

	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		"ra-icon-doc",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation":
		"ra-icon-ppt"
}

var FILE_TYPE_NAMES = {
	"text/plain": "Text",
	"text/html": "HTML",
	"application/pdf": "PDF",
	"image/jpeg": "JPEG",
	"application/vnd.etsi.asic-e+zip": "Digidoc",
	"application/vnd.ms-powerpoint": "Microsoft PowerPoint",
	"application/vnd.ms-outlook": "Microsoft Outlook Email",
	"application/msword": "Microsoft Word",

	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		"Microsoft Word",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation":
		"Microsoft PowerPoint",

	// https://api.riigikogu.ee/api/files/800ed589-3d0b-4048-9b70-2ff6b0684ed4
	// has its type as "application/digidoc. I've not yet found whether that has
	// ever been a valid MIME type.
	"application/digidoc": "Digidoc"
}

function ReadPage(attrs) {
	var {req} = attrs
	var {t} = attrs
	var {user} = req
  var {lang} = req
	var {thank} = attrs
	var {thankAgain} = attrs
	var {signature} = attrs
	var {files} = attrs
	var {comments} = attrs
	var {subscription} = attrs
	var {flash} = attrs
	var {events} = attrs
	var {initiative} = attrs
	var initiativePath = "/initiatives/" + initiative.uuid
	var {subscriberCounts} = attrs
	var signatureCount = initiative.signature_count
	var {text} = attrs
	var {textLanguage} = attrs
	var {translations} = attrs
	var {image} = attrs
	var {coauthorInvitation} = attrs
	var initiativeUrl = serializeInitiativeUrl(initiative)
	var shareText = `${initiative.title} ${initiativeUrl}`
	var atomPath = req.baseUrl + req.path + ".atom"
	var isAuthor = user && Initiative.isAuthor(user, initiative)

	var imageEditable = (
		isAuthor &&
		initiative.phase != "done" &&
		!initiative.archived_at
	)

	return <InitiativePage
		page="initiative"
		title={initiative.title}
		initiative={initiative}

		meta={_.filterValues({
			"twitter:card": "summary_large_image",
			"og:title": initiative.title,
			"og:url": initiativeUrl,
			"og:image": image && serializeImageUrl(initiative, image)
		}, Boolean)}

		links={[{
			rel: "alternate",
			type: "application/atom+xml",
			title: t("ATOM_INITIATIVE_FEED_TITLE", {title: initiative.title}),
			href: atomPath
		}]}

		req={req}>
		<script src="/assets/html5.js" />
		<script src="/assets/hwcrypto.js" />

		{initiative.destination ? <PhasesView
      t={t}
      initiative={initiative}
			signatureCount={signatureCount}
    /> : null}

		<section class="initiative-section transparent-section"><center>
			{!thank ? <QuicksignView
				req={req}
				t={t}
				class="mobile"
				initiative={initiative}
				signature={signature}
				signatureCount={signatureCount}
			/> : null}

			<div id="initiative-sheet" class="initiative-sheet">
				<Flash flash={flash} />

				{thank ? <div class="initiative-status">
          <h1 class="status-serif-header">{thankAgain
            ? t("THANKS_FOR_SIGNING_AGAIN")
            : t("THANKS_FOR_SIGNING")
          }</h1>

          <h2 class="status-subheader">{t("SUPPORT_US_TITLE")}</h2>
          {Jsx.html(I18n.markdown(lang, "donate"))}
					<DonateForm req={req} t={t} />

          <h2 class="status-subheader">
            {t("INITIATIVE_SIDEBAR_FOLLOW_HEADER")}
          </h2>

          <h3 class="status-subsubheader">
            {t("INITIATIVE_SIDEBAR_SUBSCRIBE")}
          </h3>

					{initiative.published_at ?
						<SubscribeEmailView
							req={req}
							initiative={initiative}
							count={subscriberCounts.initiative}
							allCount={subscriberCounts.all}
							t={t}
						/>
					: null}
				</div> : null}

				{coauthorInvitation ? <div
					id="coauthor-invitation"
					class="initiative-status"
				>
					<h2 class="status-serif-header">
						{t("INITIATIVE_COAUTHOR_INVITATION_PAGE_TITLE")}
					</h2>

					<p>{t("USER_PAGE_COAUTHOR_INVITATION_DESCRIPTION")}</p>
					<CoauthorInvitationForm req={req} invitation={coauthorInvitation} />
				</div> : null}

				{function(phase) {
					switch (phase) {
						case "edit":
							if (
								initiative.published_at &&
								new Date < initiative.discussion_ends_at
							) return <div class="initiative-status">
								<h1 class="status-header">
									{t("INITIATIVE_IN_DISCUSSION")}
									{" "}
									<a
										href="#comment-form"
										class="link-button wide-button">
										{t("ADD_YOUR_COMMENT")}
									</a>.
								</h1>
							</div>
							else return null

						case "sign":
							var signatureThreshold = getRequiredSignatureCount(initiative)

							if (initiative.signing_ends_at <= new Date) {
								return <div class="initiative-status">
									{signatureCount >= signatureThreshold ? <Fragment>
                    <h1 class="status-header">
                      {t("N_SIGNATURES_COLLECTED", {votes: signatureCount})}
                    </h1>

										<p>{initiative.destination == "parliament"
											? t("VOTING_SUCCEEDED")
											: t("VOTING_SUCCEEDED_ON_LOCAL_LEVEL")
										}</p>
									</Fragment> : <Fragment>
                    <h1 class="status-header">
                      {t("N_SIGNATURES_FAILED", {votes: signatureCount})}
                    </h1>

										<p>
											{t("VOTING_FAILED", {signatureCount: signatureThreshold})}
										</p>
									</Fragment>}
								</div>
							}
							else return null

						case "parliament": return <div class="initiative-status">
							<h1 class="status-header">
								{t("INITIATIVE_IN_PARLIAMENT")}
								{" "}
								<a href="#initiative-events" class="link-button wide-button">
									{t("LOOK_AT_EVENTS")}
								</a>.
							</h1>
						</div>

						case "government": return <div class="initiative-status">
							<h1 class="status-header">
								{initiative.destination == "parliament"
									? t("INITIATIVE_IN_GOVERNMENT")
									: t("INITIATIVE_IN_LOCAL_GOVERNMENT")
								}
								{" "}
								<a href="#initiative-events" class="link-button wide-button">
									{t("LOOK_AT_EVENTS")}
								</a>.
							</h1>
						</div>

						case "done":
							return <div class="initiative-status">
								<h1 class="status-header">
										{t("INITIATIVE_PROCESSED")}
										{" "}
									<a
										href="#initiative-events"
										class="link-button wide-button">
										{t("LOOK_AT_EVENTS")}
									</a>.
								</h1>
							</div>

						default: throw new RangeError("Invalid phase: " + initiative.phase)
					}
				}(initiative.phase)}

				{!_.isEmpty(translations) ? <menu id="language-tabs">
					{LANGUAGES.map(function(lang) {
						if (!(initiative.language == lang || lang in translations))
							return null

						var path = initiativePath
						if (initiative.language != lang) path += "?language=" + lang
						var klass = "tab " + selected(textLanguage, lang)

						return <a href={path} class={klass}>{Jsx.html(
							initiative.language != lang
							? t("INITIATIVE_LANG_TAB_TRANSLATION_" + lang.toUpperCase())
							: initiative.phase == "sign"
							? t("INITIATIVE_LANG_TAB_SIGNABLE_" + lang.toUpperCase())
							: t("INITIATIVE_LANG_TAB_" + lang.toUpperCase())
						)}</a>
					})}
				</menu> : null}

				<InitiativeContentView
					initiative={initiative}
					text={text}
					files={files}
				/>

				{Initiative.isSignable(new Date, initiative) ? <div
					id="initiative-vote"
				>
					<ProgressView
						t={t}
						initiative={initiative}
						signatureCount={signatureCount}
					/>

					<ProgressTextView
						t={t}
						initiative={initiative}
						signatureCount={signatureCount}
					/>

					{signature ? <Fragment>
						<h2>{t("THANKS_FOR_SIGNING")}</h2>

						<div class="signature-buttons">
							<DownloadSignatureButton signature={signature}>
								{t("DOWNLOAD_SIGNATURE")}
							</DownloadSignatureButton>

							<span class="form-or">{t("FORM_OR")}</span>

							<DeleteSignatureButton req={req} signature={signature}>
								{t("REVOKE_SIGNATURE")}
							</DeleteSignatureButton>
						</div>
					</Fragment> : <Fragment>
						<h2>{t("INITIATIVE_SIGN_HEADING")}</h2>
						<p>
							{(initiative.language != textLanguage) ? <Fragment>
								{Jsx.html(t("INITIATIVE_SIGN_TRANSLATION_WARNING", {
									language: t(
										"INITIATIVE_SIGN_TRANSLATION_WARNING_TEXT_IN_" +
										initiative.language.toUpperCase()
									),

									translation: t(
										"INITIATIVE_SIGN_TRANSLATION_WARNING_TRANSLATION_IN_" +
										textLanguage.toUpperCase()
									)
								}))}

								{" "}

								{Jsx.html(t(
									"INITIATIVE_SIGN_TRANSLATION_WARNING_SIGN_IN_" +
									initiative.language.toUpperCase()
								))}

								{" "}
							</Fragment> : null}

							{initiative.destination == "parliament"
								? t("INITIATIVE_SIGN_DESCRIPTION_FOR_PARLIAMENT")
								: t("INITIATIVE_SIGN_DESCRIPTION_FOR_LOCAL")
							}
							</p>

							<SigningView
								req={req}
								t={t}
								action={initiativePath + "/signatures"}
							/>
					</Fragment>}
				</div> : null}
			</div>

			<aside id="initiative-sidebar">
				<div class="sidebar-section">
					<QuicksignView
						req={req}
						t={t}
						initiative={initiative}
						signature={signature}
						signatureCount={signatureCount}
					/>

					<InitiativeLocationView t={t} initiative={initiative} />

					{image ? <figure
						id="initiative-image"
						class={imageEditable ? "editable" : ""}
					>
						<a href={serializeImageUrl(initiative, image)} class="image-link">
							<img src={serializeImageUrl(initiative, image)} />
						</a>

						{(
							image.author_name ||
							image.author_url ||
							imageEditable
						) ? <figcaption
							class={image.author_name || image.author_url ? "" : "empty"}
						>
							{image.author_name || image.author_url ? <Fragment>
								{t("INITIATIVE_IMAGE_AUTHOR_IS")}: {renderImageAuthor(image)}
							</Fragment> : Jsx.html(t("INITIATIVE_IMAGE_AUTHOR_EMPTY"))}
						</figcaption> : null}

						{imageEditable ? <input
							type="checkbox"
							id="initiative-image-author-toggle"
							hidden
						/> : null}

						{imageEditable ? <menu>
							<input
								type="checkbox"
								id="initiative-image-author-toggle"
								hidden
							/>

							{image.author_name || image.author_url ? <Fragment>
								<label
									class="link-button"
									for="initiative-image-author-toggle">
									{t("INITIATIVE_IMAGE_AUTHOR_EDIT")}
								</label>
								{", "}
							</Fragment> : null}

							<InitiativeImageUploadForm
								req={req}
								initiative={initiative}
								class="link-button">
								{t("INITIATIVE_IMAGE_REPLACE_IMAGE")}
							</InitiativeImageUploadForm>

							<span class="form-or">{t("FORM_OR")}</span>

							<FormButton
								req={req}
								action={initiativePath + "/image"}
								name="_method"
								value="delete"
								onclick={confirm(t("INITIATIVE_IMAGE_CONFIRM_REMOVAL"))}
								class="link-button">
								{t("INITIATIVE_IMAGE_REMOVE_IMAGE")}
							</FormButton>
						</menu> : null}

						{imageEditable ? <Form
							req={req}
							id="initiative-image-author-form"
							method="put"
							action={initiativePath + "/image"}>
							<h4 class="form-header">
								{t("INITIATIVE_IMAGE_AUTHOR_NAME_LABEL")}
							</h4>

							<input
								name="author_name"
								type="text"
								class="form-input"
								maxlength={IMAGE_SCHEMA.properties.author_name.maxLength}
								value={image.author_name}
							/>

							<h4 class="form-header">
								{t("INITIATIVE_IMAGE_AUTHOR_URL_LABEL")}
							</h4>

							<input
								name="author_url"
								type="url"
								class="form-input"
								placeholder="https://"
								maxlength={IMAGE_SCHEMA.properties.author_url.maxLength}
								value={image.author_url}
							/>

							<p>{t("INITIATIVE_IMAGE_AUTHOR_URL_DESCRIPTION")}</p>

							<div class="form-buttons">
								<button type="submit" class="green-button">
									{t("INITIATIVE_IMAGE_AUTHOR_UPDATE")}
								</button>

								<span class="form-or">{t("FORM_OR")}</span>

								<label class="link-button" for="initiative-image-author-toggle">
									{t("INITIATIVE_IMAGE_AUTHOR_CANCEL")}
								</label>
							</div>
						</Form> : null}
					</figure> : imageEditable ? <InitiativeImageUploadForm
						id="initiative-image-form"
						req={req}
						initiative={initiative}>
						<a>{t("INITIATIVE_IMAGE_ADD_IMAGE")}</a>
						<p>{Jsx.html(t("INITIATIVE_IMAGE_ADD_IMAGE_DESCRIPTION"))}</p>
					</InitiativeImageUploadForm> : null}

					{initiative.published_at ? <Fragment>
						<h3 class="sidebar-subheader">{t("SHARE_INITIATIVE")}</h3>

						<a
							href={"https://facebook.com/sharer/sharer.php?u=" + encode(initiativeUrl)}
							target="_blank"
							rel="external noopener"
							class="grey-button ra-icon-facebook-logo share-button">
							{t("SHARE_ON_FACEBOOK")}
						</a>

						<a
							href={"https://twitter.com/intent/tweet?text=" + encode(shareText)}
							target="_blank"
							rel="external noopener"
							class="grey-button ra-icon-twitter-logo share-button">
							{t("SHARE_ON_TWITTER")}
						</a>
					</Fragment> : null}
				</div>

				<SidebarAuthorView
					req={req}
					initiative={initiative}
					text={text}
					hasComments={comments.length > 0}
					translations={translations}
				/>

				<SidebarInfoView
					req={req}
					user={user}
					initiative={initiative}
				/>

				<SidebarSubscribeView
					req={req}
					initiative={initiative}
					subscriberCounts={subscriberCounts}
				/>

				<div id="initiative-disclaimer" class="sidebar-section">
					<p class="text">{Jsx.html(t("INITIATIVE_PAGE_DISCLAIMER"))}</p>
				</div>

				<SidebarAdminView
					req={req}
					initiative={initiative}
				/>
			</aside>
		</center></section>

		<EventsView
			t={t}
			user={user}
			initiative={initiative}
			events={events}
		/>

		<CommentsView
			t={t}
			req={req}
			initiative={initiative}
			subscription={subscription}
			comments={comments}
		/>
	</InitiativePage>
}

function PhasesView(attrs) {
  var {t} = attrs
  var {initiative} = attrs
  var sigs = attrs.signatureCount
	var {phase} = initiative
  var acceptedByParliamentAt = initiative.accepted_by_parliament_at
	var finishedInParliamentAt = initiative.finished_in_parliament_at
	var sentToGovernmentAt = initiative.sent_to_government_at
	var finishedInGovernmentAt = initiative.finished_in_government_at

	var receivedByParliamentAt = (
		initiative.received_by_parliament_at ||
		initiative.sent_to_parliament_at
	)

  var daysSinceCreated = diffInDays(new Date, initiative.created_at)

  var daysInEdit = initiative.discussion_ends_at ? diffInDays(
		DateFns.addMilliseconds(initiative.discussion_ends_at, -1),
		initiative.created_at
	) + 1 : 0

	var editProgress = isPhaseAfter("edit", phase)
		? 1
		: min(daysSinceCreated / daysInEdit, 1)

	var editPhaseText
	if (phase == "edit") {
		if (!initiative.published_at)
			editPhaseText = ""
		else if (new Date < initiative.discussion_ends_at)
			editPhaseText = t("TXT_DEADLINE_CALENDAR_DAYS_LEFT", {
				numberOfDaysLeft: daysInEdit - daysSinceCreated
			})
		else editPhaseText = t("DISCUSSION_FINISHED")
	}
	else if (initiative.external)
		editPhaseText = ""
	// TODO: Use initiative.published_at here once old CitizenOS initiatives have
	// it adjusted from the imported 1970-01-01 time.
	else if (initiative.signing_started_at) editPhaseText = I18n.formatDateSpan(
		"numeric",
		initiative.created_at,
		initiative.signing_started_at
	)

	var signProgress = isPhaseAfter("sign", phase)
		? 1
		: sigs / getRequiredSignatureCount(initiative)

  var signPhaseText

	if (isPhaseAtLeast("sign", phase)) {
		if (initiative.external)
			signPhaseText = t("N_SIGNATURES_EXTERNAL")
		else if (initiative.has_paper_signatures)
			signPhaseText = t("N_SIGNATURES_WITH_PAPER", {votes: sigs})
		else
			signPhaseText = t("N_SIGNATURES", {votes: sigs})
	}

	var parliamentProgress
  var parliamentPhaseText

	if (initiative.destination != "parliament");
	else if (isPhaseAfter("parliament", phase) || finishedInParliamentAt) {
		parliamentProgress = 1

		parliamentPhaseText = finishedInParliamentAt ? I18n.formatDateSpan(
			"numeric",
			receivedByParliamentAt,
			finishedInParliamentAt
		) : ""
	}
	else if (phase != "parliament");
	else if (receivedByParliamentAt && !acceptedByParliamentAt) {
    var daysSinceSent = diffInDays(new Date, receivedByParliamentAt)
    let daysLeft = PARLIAMENT_ACCEPTANCE_DEADLINE_IN_DAYS - daysSinceSent
		parliamentProgress = daysSinceSent / PARLIAMENT_ACCEPTANCE_DEADLINE_IN_DAYS

		if (daysLeft > 0)
			parliamentPhaseText = t("PARLIAMENT_PHASE_ACCEPTANCE_N_DAYS_LEFT", {
				days: daysLeft
			})
    else if (daysLeft == 0)
      parliamentPhaseText = t("PARLIAMENT_PHASE_ACCEPTANCE_0_DAYS_LEFT")
    else
			parliamentPhaseText = t("PARLIAMENT_PHASE_ACCEPTANCE_N_DAYS_OVER", {
				days: Math.abs(daysLeft)
			})
  }
	else if (acceptedByParliamentAt) {
		var proceedingsDeadline = DateFns.addMonths(
			acceptedByParliamentAt,
			PARLIAMENT_PROCEEDINGS_DEADLINE_IN_MONTHS
		)

    var daysSinceAccepted = diffInDays(new Date, acceptedByParliamentAt)
		let daysLeft = diffInDays(proceedingsDeadline, new Date)
		var daysTotal = diffInDays(proceedingsDeadline, acceptedByParliamentAt)

		parliamentProgress = isPhaseAfter("parliament", phase)
			? 1
			: daysSinceAccepted / daysTotal

		if (daysLeft > 0)
			parliamentPhaseText = t("PARLIAMENT_PHASE_N_DAYS_LEFT", {days: daysLeft})
    else if (daysLeft == 0)
      parliamentPhaseText = t("PARLIAMENT_PHASE_0_DAYS_LEFT")
    else
			parliamentPhaseText = t("PARLIAMENT_PHASE_N_DAYS_OVER", {
				days: Math.abs(daysLeft)
			})
	}

	var governmentProgress
  var governmentPhaseText

	if (
		isPhaseAtLeast("government", phase) &&
		(phase == "government" || sentToGovernmentAt)
	) {
		governmentProgress = (
			isPhaseAfter("government", phase) ||
			finishedInGovernmentAt
		) ? 1 : 0

		governmentPhaseText = finishedInGovernmentAt ? I18n.formatDateSpan(
			"numeric",
			sentToGovernmentAt,
			finishedInGovernmentAt
		) : sentToGovernmentAt
			? I18n.formatDate("numeric", sentToGovernmentAt)
			: ""
	}
	else if (
		initiative.destination != null &&
		initiative.destination != "parliament"
	) governmentProgress = 0

  return <section id="initiative-phases" class="transparent-section"><center>
    <ol>
			<li id="edit-phase" class={classifyPhase("edit", phase)}>
        <i>{t("EDIT_PHASE")}</i>
				<ProgressView value={editProgress} text={editPhaseText} />
      </li>

			<li id="sign-phase" class={classifyPhase("sign", phase)}>
        <i>{t("SIGN_PHASE")}</i>
				<ProgressView value={signProgress} text={signPhaseText} />
      </li>

			{initiative.destination == "parliament" ? <li
				id="parliament-phase"
				class={
					classifyPhase("parliament", phase) +
					(governmentProgress != null ? " with-government" : "")
				}
			>
        <i>{t("PARLIAMENT_PHASE")}</i>
				<ProgressView
					before={initiative.parliament_committee}
					value={parliamentProgress}
					text={parliamentPhaseText}
				/>
      </li> : null}

			{governmentProgress != null ? <li
				id="government-phase"
				class={classifyPhase("government", phase)}
			>
				<i>{initiative.destination == "parliament"
					? t("GOVERNMENT_PHASE")
					: t("LOCAL_GOVERNMENT_PHASE")
				}</i>

				<ProgressView
					before={initiative.government_agency}
					value={governmentProgress}
					text={governmentPhaseText}
				/>
      </li> : null}

			{phase == "done" && initiative.archived_at ? <li
				id="archived-phase"
				class="current">
        <i>{t("ARCHIVED_PHASE")}</i>
			</li> : <li
				id="done-phase"
				class={classifyPhase("done", phase)}>
        <i>{t("DONE_PHASE")}</i>
      </li>}
    </ol>
  </center></section>

	function ProgressView(attrs) {
		var value = attrs && attrs.value
		var before = attrs && attrs.before
		var text = attrs && attrs.text

		// Linebreaks are for alignment _and_ rendering without CSS.
		return <label class="progress">
			{before}<br />
			<progress value={value == null ? null : min(1, value)} /><br />
			{text}
		</label>
	}

	function classifyPhase(phase, given) {
		var dist = PHASES.indexOf(given) - PHASES.indexOf(phase)
		return dist == 0 ? "current" : dist > 0 ? "past" : ""
	}
}

function InitiativeContentView(attrs) {
	var {initiative} = attrs
	var {text} = attrs
	var initiativePath = "/initiatives/" + initiative.uuid
	var {files} = attrs

	if (initiative.external) {
		var pdf = files.find((file) => file.content_type == "application/pdf")
		if (pdf == null) return null

		return <article class="pdf">
			<object
				data={initiativePath + "/files/" + pdf.id}
				type={pdf.content_type}
			/>
		</article>
	}

	if (text) switch (String(text.content_type)) {
		case "text/html":
			return <article class="text" lang={text.language}>
				{Jsx.html(text.content)}
				</article>

		case "application/vnd.basecamp.trix+json":
			return <article class="text trix-text" lang={text.language}>
				{Trix.render(text.content, {heading: "h2"})}
			</article>

		case "application/vnd.citizenos.etherpad+html":
			var html = normalizeCitizenOsHtml(text.content)
			html = html.match(/<body>([^]*)<\/body>/m)[1]

			return <article class="text citizenos-text" lang={text.language}>
				{Jsx.html(html)}
			</article>

		default:
			throw new RangeError("Unsupported content type: " + text.content_type)
	}

	return null
}

function SidebarAuthorView(attrs) {
	var {req} = attrs
	var {user} = req
	var {initiative} = attrs
	var {translations} = attrs
	var isCreator = user && initiative.user_id == user.id

	var isAuthor = user && Initiative.isAuthor(user, initiative)
	if (!isAuthor) return null

	var {t} = req
	var {text} = attrs
	var signatureCount = initiative.signature_count
	var {hasComments} = attrs

	var initiativePath = "/initiatives/" + initiative.uuid
	var coauthorsPath = initiativePath + "/coauthors"

	var textEditPath = text && initiative.language != text.language
		? initiativePath + "/edit?language=" + text.language
		: initiativePath + "/edit"

	var hasEstonianText = initiative.language == "et" || translations.et
	var canPublish = Initiative.canPublish(user)

	var canSendToSign = (
		Initiative.canPropose(new Date, initiative, user) &&
		hasEstonianText
	)

	var actions = <Fragment>
		{initiative.phase == "edit" ? <Fragment>
			<Form
				req={req}
				id="initiative-destination-form"
				method="put"
				action={initiativePath}
			>
				<h3 class="sidebar-subheader">Algatuse saaja</h3>

				<InitiativeDestinationSelectView
					name="destination"
					initiative={initiative}
					placeholder="Vali Riigikogu või omavalitsus…"
					class="form-select"
					onchange="this.form.submit()"
				/>

				<noscript>
					<button type="submit" class="secondary-button">
						{t("INITIATIVE_PAGE_DESTINATION_UPDATE_BUTTON")}
					</button>
				</noscript>

				<p>{Jsx.html(t("INITIATIVE_PAGE_DESTINATION_UPDATE_DESCRIPTION", {
					email: _.escapeHtml(Config.helpEmail)
				}))}</p>
			</Form>
		</Fragment> : null}

		{!initiative.published_at && text ? <Fragment>
			<FormButton
				req={req}
				id="publish-button"
				action={initiativePath}
				name="visibility"
				value="public"
				disabled={!canPublish}
				class="green-button wide-button">
				{t("PUBLISH_TOPIC")}
			</FormButton>

			{user.email == null && user.unconfirmed_email == null ? <p>
				{Jsx.html(t("PUBLISH_INITIATIVE_SET_EMAIL", {userUrl: "/user"}))}
			</p> : user.email_confirmed_at == null ? <p>
				{Jsx.html(t("PUBLISH_INITIATIVE_CONFIRM_EMAIL"))}
			</p> : null}
		</Fragment> : null}

		{initiative.phase == "edit" && initiative.published_at ? <Fragment>
			<FormButton
				req={req}
				id="send-to-sign-button"
				action={initiativePath}
				name="status"
				value="voting"
				disabled={!canSendToSign}
				class="green-button wide-button">
				{t("BTN_SEND_TO_VOTE")}
			</FormButton>

			{!(
				new Date >= DateFns.addDays(
					DateFns.startOfDay(initiative.published_at),
					Config.minDeadlineDays
				) ||

				initiative.tags.includes("fast-track")
			) ? <p>
				{t("INITIATIVE_SEND_TO_SIGNING_WAIT", {
					daysInEdit: Config.minDeadlineDays,

					daysLeft: diffInDays(
						DateFns.addDays(
							DateFns.startOfDay(initiative.published_at),
							Config.minDeadlineDays
						),

						new Date
					)
				})}
			</p> : !hasEstonianText ? <p>{Jsx.html(
				t("INITIATIVE_SEND_TO_SIGNING_NEEDS_ESTONIAN_TEXT", {
					newTextUrl: _.escapeHtml(initiativePath + "/texts/new?language=et")
				})
			)}</p> : null}

			{initiative.destination == null ? <p>
				{t("INITIATIVE_SEND_TO_SIGNING_NEEDS_DESTINATION")}
			</p> : null}
		</Fragment> : null}

		{(
			Initiative.canSendToParliament(initiative, user, signatureCount) ||
			Initiative.canSendToLocalGovernment(initiative, user, signatureCount)
		) ? <Fragment>
			<FormButton
				req={req}
				action={initiativePath}
				name="status"
				value="followUp"

				id={initiative.destination == "parliament"
					? "send-to-parliament-button"
					: "send-to-local-government-button"
				}

				disabled={!hasEstonianText}
				class="green-button wide-button"
			>
				{initiative.destination == "parliament"
					? t("SEND_TO_PARLIAMENT")
					: t("SEND_TO_LOCAL_GOVERNMENT")
				}
			</FormButton>

			{!hasEstonianText ? <p>{Jsx.html(
				t("INITIATIVE_SEND_TO_PARLIAMENT_NEEDS_ESTONIAN_TEXT", {
					newTextUrl: _.escapeHtml(initiativePath + "/texts/new?language=et")
				})
			)}</p> : null}
		</Fragment> : null}

		{initiative.phase == "edit" ? <a
			href={textEditPath}
			class="link-button wide-button">
			{t("EDIT_INITIATIVE_TEXT")}
		</a> : null}

		{initiative.phase == "sign" ? <a
			href={textEditPath}
			class="link-button wide-button">
			{t("EDIT_INITIATIVE_TRANSLATIONS")}
		</a> : null}

		{isCreator ? <a
			href={coauthorsPath}
			class="link-button wide-button">
			{t("EDIT_INITIATIVE_AUTHORS")}
		</a> : null}

		{initiative.phase == "edit" && initiative.published_at ? <FormButton
			req={req}
			action={initiativePath}
			name="visibility"
			value="public"
			class="link-button wide-button">
			{t("RENEW_DEADLINE")}
		</FormButton> : null}

		{Initiative.canUpdateSignDeadline(initiative, user) ? <FormButton
			req={req}
			action={initiativePath}
			name="status"
			value="voting"
			class="link-button wide-button">
			{t("RENEW_DEADLINE")}
		</FormButton> : null}

		{isAuthor && !isCreator ? <FormButton
			req={req}
			action={coauthorsPath + "/" + user.country + user.personal_id}
			name="_method"
			value="delete"
			onclick={confirm(t("INITIATIVE_COAUTHOR_DELETE_SELF_CONFIRMATION"))}
			class="link-button wide-button">
			{t("INITIATIVE_COAUTHOR_DELETE_SELF")}
		</FormButton> : null}

		{(
			isCreator &&
			initiative.phase == "edit" &&
			(!hasComments || !initiative.published_at)
		) ? <FormButton
			req={req}
			action={initiativePath}
			name="_method"
			value="delete"
			onclick={confirm(t("TXT_ALL_DISCUSSIONS_AND_VOTES_DELETED"))}
			class="link-button wide-button">
			{t("DELETE_DISCUSSION")}
		</FormButton> : null}
	</Fragment>

	if (!actions.some(Boolean)) return null

	return <div id="initiative-author-options" class="sidebar-section">
		<h2 class="sidebar-header">{t("INITIATIVE_EDIT_TITLE")} </h2>
		{actions}
	</div>
}

function SidebarInfoView(attrs) {
	var {req} = attrs
	var {t} = req
	var {user} = attrs
	var {initiative} = attrs
	var canEdit = user && Initiative.isAuthor(user, initiative)
	var {phase} = initiative
	var authorName = initiative.author_name
	var coauthorNames = _.map(initiative.coauthors, "user_name")
	var authorUrl = initiative.author_url
	var authorContacts = initiative.author_contacts
	var communityUrl = initiative.community_url
	var externalUrl = initiative.url
	var {organizations} = initiative
	var mediaUrls = initiative.media_urls
	var {meetings} = initiative
	var {notes} = initiative
	var governmentChangeUrls = initiative.government_change_urls
	var publicChangeUrls = initiative.public_change_urls
	var initiativePath = "/initiatives/" + initiative.uuid

	if (!(
		canEdit ||
		authorName ||
		coauthorNames.length > 0 ||
		authorUrl ||
		authorContacts ||
		communityUrl ||
		organizations.length > 0 ||
		meetings.length > 0 ||
		mediaUrls.length > 0 ||
		externalUrl ||
		notes > 0
	)) return null

	return <Form
		req={req}
		id="initiative-info"
		class="sidebar-section"
		method="put"
		action={initiativePath}>
		<input type="checkbox" id="initiative-info-form-toggle" hidden />

		<h2 class="sidebar-header">
			{canEdit ? <label
				class="edit-button link-button"
				for="initiative-info-form-toggle">
				{t("EDIT_INITIATIVE_INFO")}
			</label> : null}

			{t("INITIATIVE_INFO_TITLE")}
		</h2>

		{(
			authorName ||
			authorUrl ||
			authorContacts ||
			coauthorNames.length > 0 ||
			canEdit
		) ? <Fragment>
			<h3 class="sidebar-subheader">{t("INITIATIVE_INFO_AUTHOR_TITLE")}</h3>

			<div class="form-output">
				<ul>
					{authorName || authorUrl || authorContacts ? <li>
						<UntrustedLink href={authorUrl}>{authorName || null}</UntrustedLink>
					</li> : null}

					{(
						(authorName || authorUrl || coauthorNames.length) &&
						authorName != initiative.user_name
					) ? <li>{initiative.user_name}</li> : null}

					{coauthorNames.map((name) => <li>{name}</li>)}
				</ul>

				{authorContacts ? <p id="initiative-author-contacts">
					{Jsx.html(linkify(authorContacts))}
				</p> : null}
			</div>

			{canEdit ? <div class="form-fields">
				<h4 class="form-header">{t("INITIATIVE_INFO_AUTHOR_NAME_TITLE")}</h4>

				<input
					name="author_name"
					type="name"
					class="form-input"
					value={authorName}
					maxlength={SCHEMA.properties.author_name.maxLength}
				/>

				<p>{Jsx.html(t("INITIATIVE_INFO_AUTHOR_NAME_DESCRIPTION", {
					coauthorsUrl: _.escapeHtml(initiativePath + "/coauthors")
				}))}</p>
			</div> : null}

			{canEdit ? <div class="form-fields">
				<h4 class="form-header">{t("INITIATIVE_INFO_AUTHOR_URL_TITLE")}</h4>

				<input
					name="author_url"
					type="url"
					class="form-input"
					placeholder="https://"
					value={authorUrl}
					maxlength={SCHEMA.properties.author_url.maxLength}
				/>

				<p>{t("INITIATIVE_INFO_AUTHOR_URL_DESCRIPTION")}</p>
			</div> : null}

			{canEdit ? <div class="form-fields">
				<h4 class="form-header">{t("INITIATIVE_INFO_AUTHOR_CONTACTS_TITLE")}</h4>

				<textarea
					name="author_contacts"
					type="contacts"
					class="form-textarea"
					maxlength={SCHEMA.properties.author_contacts.maxLength}
				>
					{authorContacts}
				</textarea>

				<p>{t("INITIATIVE_INFO_AUTHOR_CONTACTS_DESCRIPTION")}</p>
			</div> : null}

			{authorName || authorUrl || authorContacts || coauthorNames.length > 0
				? null
				: <AddInitiativeInfoButton t={t} />
			}
		</Fragment> : null}

		{communityUrl || canEdit ? <InitiativeAttribute
			t={t}
			editable={canEdit}
			title={t("INITIATIVE_INFO_COMMUNITY_URL_TITLE")}
			help={t("INITIATIVE_INFO_COMMUNITY_URL_DESCRIPTION")}
			name="community_url"
			placeholder="https://"
			value={communityUrl}
			maxlength={SCHEMA.properties.community_url.maxLength}
		>
			<UntrustedLink class="form-output" href={communityUrl} />
		</InitiativeAttribute> : null}

		{organizations.length > 0 || canEdit ? <Fragment>
			<h3 class="sidebar-subheader">
				{t("INITIATIVE_INFO_ORGANIZATIONS_TITLE")}
			</h3>

			{organizations.length > 0 ? <ul class="form-output">
				{organizations.map((organization) => <li>
					<UntrustedLink href={organization.url}>
						{organization.name}
					</UntrustedLink>
				</li>)}
			</ul> : <AddInitiativeInfoButton t={t} />}

			{canEdit ? <InitiativeAttributeList
				id="initiative-organizations-form"
				add={t("INITIATIVE_INFO_ORGANIZATIONS_ADD")}
				help={t("INITIATIVE_INFO_ORGANIZATIONS_DESCRIPTION")}
				values={organizations}
				default={EMPTY_ORG}
			>{(organization, i) => <li>
				<input
					class="form-input"
					placeholder={t("INITIATIVE_INFO_ORGANIZATIONS_NAME_PLACEHOLDER")}
					name={`organizations[${i}][name]`}
					value={organization.name}
					maxlength={
						SCHEMA.properties.organizations.items.properties.name.maxLength
					}
				/>

				<input
					class="form-input"
					type="url"
					name={`organizations[${i}][url]`}
					value={organization.url}
					placeholder="https://"
					maxlength={
						SCHEMA.properties.organizations.items.properties.url.maxLength
					}
				/>
			</li>}</InitiativeAttributeList>: null}
		</Fragment> : null}

		{meetings.length > 0 || canEdit ? <Fragment>
			<h3 class="sidebar-subheader">
				{t("INITIATIVE_INFO_DISCUSSIONS_TITLE")}
			</h3>

			{meetings.length > 0 ? <ul class="form-output">
				{meetings.map((meeting) => <li>
					<UntrustedLink href={meeting.url}>
						{I18n.formatDate("numeric", Time.parseIsoDate(meeting.date))}
					</UntrustedLink>
				</li>)}
			</ul> : <AddInitiativeInfoButton t={t} />}

			{canEdit ? <InitiativeAttributeList
				id="initiative-meetings-form"
				add={t("INITIATIVE_INFO_DISCUSSIONS_ADD")}
				help={t("INITIATIVE_INFO_DISCUSSIONS_DESCRIPTION")}
				values={meetings}
				default={EMPTY_ORG}
			>{(meeting, i) => <li>
				<input
					class="form-input"
					type="date"
					placeholder={t("INITIATIVE_INFO_DISCUSSIONS_NAME_PLACEHOLDER")}
					name={`meetings[${i}][date]`}
					value={meeting.date}
				/>

				<input
					class="form-input"
					type="url"
					name={`meetings[${i}][url]`}
					value={meeting.url}
					placeholder="https://"
					maxlength={SCHEMA.properties.meetings.items.properties.url.maxLength}
				/>
			</li>}</InitiativeAttributeList>: null}
		</Fragment> : null}

		{isPhaseAtLeast("sign", phase) ? <Fragment>
			{externalUrl || canEdit ? <InitiativeAttribute
				t={t}
				editable={canEdit}
				title={t("INITIATIVE_INFO_EXTERNAL_URL_TITLE")}
				name="url"
				type="url"
				placeholder="https://"
				maxlength={SCHEMA.properties.url.maxLength}
				value={externalUrl}
			>
				<UntrustedLink class="form-output" href={externalUrl} />
			</InitiativeAttribute> : null}
		</Fragment> : null}

		{isPhaseAtLeast("parliament", phase) ? <Fragment>
			{mediaUrls.length > 0 || canEdit ? <Fragment>
				<h3 class="sidebar-subheader">
					{t("INITIATIVE_INFO_MEDIA_URLS_TITLE")}
				</h3>

				{mediaUrls.length > 0 ? <ul class="form-output">
					{mediaUrls.map((url) => <li>
						<UntrustedLink href={url}>{url}</UntrustedLink>
					</li>)}
				</ul> : <AddInitiativeInfoButton t={t} />}

				{canEdit ? <InitiativeAttributeList
					id="initiative-media-urls-form"
					add={t("INITIATIVE_INFO_MEDIA_URLS_ADD")}
					values={mediaUrls}
				>{(url, i) => <li>
					<input
						class="form-input"
						type="url"
						name={`media_urls[${i}]`}
						value={url}
						placeholder="https://"
						maxlength={SCHEMA.properties.media_urls.items.maxLength}
					/>
				</li>}</InitiativeAttributeList>: null}
			</Fragment> : null}
		</Fragment> : null}

		{isPhaseAtLeast("government", phase) ? <Fragment>
			{mediaUrls.length > 0 || canEdit ? <Fragment>
				<h3 class="sidebar-subheader">
					{t("INITIATIVE_INFO_GOVERNMENT_CHANGE_URLS_TITLE")}
				</h3>

				{governmentChangeUrls.length > 0 ? <ul class="form-output">
					{governmentChangeUrls.map((url) => <li>
						<UntrustedLink href={url}>{url}</UntrustedLink>
					</li>)}
				</ul> : <AddInitiativeInfoButton t={t} />}

				{canEdit ? <InitiativeAttributeList
					id="initiative-government-change-urls-form"
					add={t("INITIATIVE_INFO_GOVERNMENT_CHANGE_URLS_ADD")}
					help={t("INITIATIVE_INFO_GOVERNMENT_CHANGE_URLS_DESCRIPTION")}
					values={governmentChangeUrls}
				>{(url, i) => <li>
					<input
						class="form-input"
						type="url"
						name={`government_change_urls[${i}]`}
						value={url}
						placeholder="https://"
						maxlength={SCHEMA.properties.government_change_urls.items.maxLength}
					/>
				</li>}</InitiativeAttributeList>: null}
			</Fragment> : null}
		</Fragment> : null}

		{isPhaseAtLeast("done", phase) ? <Fragment>
			{mediaUrls.length > 0 || canEdit ? <Fragment>
				<h3 class="sidebar-subheader">
					{t("INITIATIVE_INFO_PUBLIC_CHANGE_URLS_TITLE")}
				</h3>

				{publicChangeUrls.length > 0 ? <ul class="form-output">
					{publicChangeUrls.map((url) => <li>
						<UntrustedLink href={url}>{url}</UntrustedLink>
					</li>)}
				</ul> : <AddInitiativeInfoButton t={t} />}

				{canEdit ? <InitiativeAttributeList
					id="initiative-public-change-urls-form"
					add={t("INITIATIVE_INFO_PUBLIC_CHANGE_URLS_ADD")}
					help={t("INITIATIVE_INFO_PUBLIC_CHANGE_URLS_DESCRIPTION")}
					values={publicChangeUrls}
				>{(url, i) => <li>
					<input
						class="form-input"
						type="url"
						name={`public_change_urls[${i}]`}
						value={url}
						placeholder="https://"
						maxlength={SCHEMA.properties.public_change_urls.items.maxLength}
					/>
				</li>}</InitiativeAttributeList>: null}
			</Fragment> : null}
		</Fragment> : null}

		{initiative.notes || canEdit ? <InitiativeAttribute
			t={t}
			editable={canEdit}
			type="textarea"
			title={t("NOTES_HEADER")}
			name="notes"
			value={initiative.notes}
			maxlength={SCHEMA.properties.notes.maxLength}
		>
			<p class="text form-output">{Jsx.html(linkify(initiative.notes))}</p>
		</InitiativeAttribute> : null}

		<div class="form-buttons">
			<button type="submit" class="green-button">
				{t("UPDATE_INITIATIVE_INFO")}
			</button>

			<span class="form-or">{t("FORM_OR")}</span>

			<label class="link-button" for="initiative-info-form-toggle">
				{t("CANCEL_INITIATIVE_INFO")}
			</label>
		</div>
	</Form>
}

function SidebarSubscribeView(attrs) {
	var {req} = attrs
	var {t} = req
	var {initiative} = attrs
	var {subscriberCounts} = attrs
	var atomPath = req.baseUrl + req.path + ".atom"

	if (!initiative.published_at) return null

	return <div class="sidebar-section">
		<h2 class="sidebar-header">{t("INITIATIVE_SIDEBAR_FOLLOW_HEADER")}</h2>

		<h3 class="sidebar-subheader">{t("INITIATIVE_SIDEBAR_SUBSCRIBE")}</h3>

		<SubscribeEmailView
			req={req}
			initiative={initiative}
			count={subscriberCounts.initiative}
			allCount={subscriberCounts.all}
			t={t}
		/>

		<h3 class="sidebar-subheader">{t("SUBSCRIBE_VIA_ATOM_HEADER")}</h3>

		<a href={atomPath} class="grey-button ra-icon-rss">
			{t("SUBSCRIBE_VIA_ATOM_BUTTON")}
		</a>
	</div>
}

function SidebarAdminView(attrs) {
	var {req} = attrs
	var {t} = req
	var {initiative} = attrs

	if (!(req.user && isAdmin(req.user))) return null

	return <div class="sidebar-section">
		<h2 class="sidebar-header">
			{t("INITIATIVE_ADMIN")}
		</h2>

		<a
			href={`${Config.adminUrl}/initiatives/${initiative.uuid}`}
			class="link-button wide-button">
			{t("INITIATIVE_ADMINISTRATE_INITIATIVE")}
		</a>
	</div>
}

function SigningView(attrs) {
	var {t} = attrs
	var {req} = attrs
	var {action} = attrs
	var {personalId} = attrs
	var {singlePage} = attrs

	return <div class="signing-view">
		<input
			type="radio"
			id="signature-method-tab-id-card"
			name="signature-method-tab"
			value="id-card"
			style="display: none"
		/>

		<input
			type="radio"
			name="signature-method-tab"
			id="signature-method-tab-mobile-id"
			value="mobile-id"
			style="display: none"
		/>

		<input
			type="radio"
			name="signature-method-tab"
			id="signature-method-tab-smart-id"
			value="smart-id"
			style="display: none"
		/>

		<div class="signature-methods">
			<label
				id="id-card-button"
				for="signature-method-tab-id-card"
				class="inherited-button"
			>
				<img
					src="/assets/id-kaart-button.png"
					title={t("BTN_VOTE_SIGN_WITH_ID_CARD")}
					alt={t("BTN_VOTE_SIGN_WITH_ID_CARD")}
				/>
			</label>

			<label
				for="signature-method-tab-mobile-id"
				class="inherited-button"
			>
				<img
					src="/assets/mobile-id-button.png"
					title={t("BTN_VOTE_SIGN_WITH_MOBILE_ID")}
					alt={t("BTN_VOTE_SIGN_WITH_MOBILE_ID")}
				/>
			</label>

			{Config.smartId ? <label
				for="signature-method-tab-smart-id"
				class="inherited-button"
			>
				<img
					src="/assets/smart-id-button.svg"
					title={t("BTN_VOTE_SIGN_WITH_SMART_ID")}
					alt={t("BTN_VOTE_SIGN_WITH_SMART_ID")}
				/>
			</label> : null}
		</div>

		<Form
			req={req}
			id="id-card-form"
			class="signature-form"
			method="post"
			action={action}>
			<p id="id-card-flash" class="flash error" />
		</Form>

		<Form
			req={req}
			id="mobile-id-form"
			class="signature-form"
			method="post"
			action={action}>

			<label class="form-label">
				{t("LABEL_PHONE_NUMBER")}

				<input
					type="tel"
					name="phoneNumber"
					placeholder={t("PLACEHOLDER_PHONE_NUMBER")}
					required
					class="form-input"
				/>
			</label>

			<label class="form-label">
				{t("LABEL_PERSONAL_ID")}

				<input
					type="text"
					pattern="[0-9]*"
					inputmode="numeric"
					name="personalId"
					placeholder={t("PLACEHOLDER_PERSONAL_ID")}
					value={personalId}
					required
					class="form-input"
				/>
			</label>

			<button
				name="method"
				value="mobile-id"
				class="button green-button">
				{t("BTN_VOTE_SIGN_WITH_MOBILE_ID")}
			</button>

			<output />
		</Form>

		{Config.smartId ? <Form
			req={req}
			id="smart-id-form"
			class="signature-form"
			method="post"
			action={action}>
			<label class="form-label">
				{t("LABEL_PERSONAL_ID")}

				<input
					type="text"
					pattern="[0-9]*"
					inputmode="numeric"
					name="personalId"
					placeholder={t("PLACEHOLDER_PERSONAL_ID")}
					value={personalId}
					required
					class="form-input"
				/>
			</label>

			<button
				name="method"
				value="smart-id"
				class="green-button">
				{t("BTN_VOTE_SIGN_WITH_SMART_ID")}
			</button>

			<output />
		</Form> : null}

		<script>{javascript`
			var each = Function.call.bind(Array.prototype.forEach)

			var inputs = [
				document.querySelector("#mobile-id-form input[name=personalId]"),
				document.querySelector("#smart-id-form input[name=personalId]")
			].filter(Boolean)

			inputs.forEach(function(from) {
				from.addEventListener("change", function(ev) {
					each(inputs, function(to) {
						if (to != from) to.value = ev.target.value
					})
				})
			})	
		`}</script>

		<script>{javascript`
			var Hwcrypto = require("@rahvaalgatus/hwcrypto")
			var TRANSLATIONS = ${UI_TRANSLATIONS[req.lang]}
			var button = document.getElementById("id-card-button")
			var form = document.getElementById("id-card-form")
			var flash = document.getElementById("id-card-flash")
			var all = Promise.all.bind(Promise)

			button.addEventListener("click", sign)

			form.addEventListener("submit", function(ev) {
				ev.preventDefault()
				sign()
			})

			function sign() {
				notice("")

				var certificate = Hwcrypto.certificate("sign")

				var signable = certificate.then(function(certificate) {
					return fetch(form.action, {
						method: "POST",
						credentials: "same-origin",

						headers: {
							"X-CSRF-Token": ${req.csrfToken},
							"Content-Type": "application/pkix-cert",
							Accept: ${SIGNABLE_TYPE + ", " + ERR_TYPE}
						},

						body: certificate.toDer()
					}).then(assertOk).then(function(res) {
						return res.arrayBuffer().then(function(signable) {
							return [
								res.headers.get("location"),
								new Uint8Array(signable)
							]
						})
					})
				})

				var signature = all([certificate, signable]).then(function(all) {
					var certificate = all[0]
					var signable = all[1][1]
					return Hwcrypto.sign(certificate, "SHA-256", signable)
				})

				var done = all([signable, signature]).then(function(all) {
					var url = all[0][0]
					var signature = all[1]

					return fetch(url, {
						method: "PUT",
						credentials: "same-origin",
						redirect: "manual",

						headers: {
							"X-CSRF-Token": ${req.csrfToken},
							"Content-Type": "application/vnd.rahvaalgatus.signature",

							// Fetch polyfill doesn't support manual redirect, so use
							// x-empty.
							Accept: ${"application/x-empty, " + ERR_TYPE}
						},

						body: signature
					}).then(assertOk).then(function(res) {
						window.location.assign(res.headers.get("location"))
					})
				})

				done.catch(noticeError)
				done.catch(raise)
			}

			function noticeError(err) {
				notice(
					err.code && TRANSLATIONS[err.code] ||
					err.description ||
					err.message
				)
			}

			function assertOk(res) {
				if (res.status >= 200 && res.status < 400) return res

				var err = new Error(res.statusText)
				err.code = res.status

				var type = res.headers.get("content-type")
				if (type == ${ERR_TYPE})
					return res.json().then(function(body) {
						err.description = body.description
						throw err
					})
				else throw err
			}

			function notice(msg) { flash.textContent = msg }
			function raise(err) { setTimeout(function() { throw err }) }
		`}</script>

		{singlePage ? <script>{javascript`
			var reduce = Function.call.bind(Array.prototype.reduce)

			var forms = [
				document.getElementById("mobile-id-form"),
				document.getElementById("smart-id-form")
			].filter(Boolean)

			forms.forEach(function(form) {
				form.addEventListener("submit", handleSubmit)
			})

			function handleSubmit(ev) {
				var form = ev.target
				var output = form.querySelector("output")
				function notice(msg) { output.textContent = msg || "" }

				ev.preventDefault()
				notice(${t("SIGNING_VIEW_SIGNING")})

				fetch(form.action, {
					method: "POST",
					credentials: "same-origin",

          headers: {
            "Content-Type": "application/json",
            "Accept": ${"application/json, " + ERR_TYPE}
          },

          body: JSON.stringify(serializeForm(form))
        }).then(assertOk).then(function(res) {
          var code = res.headers.get("X-Verification-Code")
          notice(${t("VERIFICATION_CODE")} + ": " + code)

          return res.json().then(function(obj) {
						if (obj.code == "OK") window.location.assign(obj.location)
						else notice(obj.description || obj.message)
          })
        }).catch(function(err) {
          notice(err.description || err.message)
        })
			}

			function serializeForm(form) {
				return reduce(form.elements, function(obj, el) {
					if (!(el.tagName == "INPUT" || el.tagName == "BUTTON")) return obj

					obj[el.name] = el.value
					return obj
				}, {})
			}

      function assertOk(res) {
        if (res.ok) return res

        var err = new Error(res.statusText)
        err.code = res.status

				var type = res.headers.get("content-type")

				if (type == ${ERR_TYPE} || /^application\\/json(;|$)/.test(type))
					return res.json().then(function(body) {
						err.message = body.message
						err.description = body.description
						throw err
					})
        else throw err
      }
		`}</script> : null}
	</div>
}

function EventsView(attrs) {
	var {t} = attrs
	var {user} = attrs
	var {initiative} = attrs
	var events = attrs.events.sort(compareEvent).reverse()
	var initiativePath = "/initiatives/" + initiative.uuid

	var canCreateEvents = (
		user &&
		Initiative.isAuthor(user, initiative) &&
		initiative.archived_at == null &&
		initiative.phase != "edit"
	)

	if (events.length > 0 || canCreateEvents)
		return <section id="initiative-events" class="transparent-section"><center>
			<a name="events" />

			<article class="initiative-sheet">
				{canCreateEvents ? <a
					href={`/initiatives/${initiative.uuid}/events/new`}
					class="create-event-button">
					{t("CREATE_INITIATIVE_EVENT_BUTTON")}
				</a> : null}

        <ol class="events">{events.map(function(event) {
					var title
					var authorName
					var content
					var summary
					var decision
					var meeting
					var links
					var klass = `event ${event.type}-event`
					var phase = initiativePhaseFromEvent(event)
					if (phase) klass += ` ${phase}-phase`
					if (event.origin == "author") klass += " author-event"

					switch (event.type) {
						case "signature-milestone":
							title = t("SIGNATURE_MILESTONE_EVENT_TITLE", {
								milestone: event.content
							})
							break

						case "sent-to-parliament":
							title = t("INITIATIVE_SENT_TO_PARLIAMENT_TITLE")

							content = <p class="text">
								{t("INITIATIVE_SENT_TO_PARLIAMENT_BODY")}
							</p>
							break

						case "parliament-received":
							title = t("PARLIAMENT_RECEIVED")
							break

						case "parliament-accepted":
							title = t("PARLIAMENT_ACCEPTED")

							var {committee} = event.content
							if (committee) content = <p class="text">
								{t("PARLIAMENT_ACCEPTED_SENT_TO_COMMITTEE", {
									committee: committee
								})}
							</p>
							break

						case "parliament-board-meeting":
							title = t("PARLIAMENT_BOARD_MEETING")
							break

						case "parliament-plenary-meeting":
							title = t("PARLIAMENT_PLENARY_MEETING")
							meeting = event.content
							summary = meeting.summary
							links = meeting.links || EMPTY_ARR

							content = <Fragment>
								{summary ? <p class="text">
									{Jsx.html(linkify(summary))}
								</p> : null}

								{links.length ? <ul class="event-links">
									{links.map((link) => <li>
										<UntrustedLink href={link.url}>{link.title}</UntrustedLink>
									</li>)}
								</ul> : null}
							</Fragment>
							break

						case "parliament-committee-meeting":
							meeting = event.content
							decision = meeting.decision
							var {invitees} = meeting
							summary = meeting.summary
							links = meeting.links || EMPTY_ARR

							title = meeting.committee
								? t("PARLIAMENT_COMMITTEE_MEETING_BY", {
									committee: meeting.committee
								})
								: t("PARLIAMENT_COMMITTEE_MEETING")

							content = <Fragment>
								{invitees ? <table class="event-table">
									<tr>
										<th scope="row">{t("PARLIAMENT_MEETING_INVITEES")}</th>
										<td><ul>{invitees.split(",").map((invitee) => (
											<li>{invitee}</li>
										))}</ul></td>
									</tr>
								</table> : null}

								{summary ? <p class="text">
									{Jsx.html(linkify(summary))}
								</p> :

								decision ? <p class="text">{
									decision == "continue"
									? t("PARLIAMENT_MEETING_DECISION_CONTINUE")
									: decision == "hold-public-hearing"
									? t("PARLIAMENT_MEETING_DECISION_HOLD_PUBLIC_HEARING")
									: decision == "reject"
									? t("PARLIAMENT_MEETING_DECISION_REJECT")
									: decision == "forward"
									? t("PARLIAMENT_MEETING_DECISION_FORWARD")
									: decision == "forward-to-government"
									? t("PARLIAMENT_MEETING_DECISION_FORWARD_TO_GOVERNMENT")
									: decision == "solve-differently"
									? t("PARLIAMENT_MEETING_DECISION_SOLVE_DIFFERENTLY")
									: decision == "draft-act-or-national-matter"
									? t("PARLIAMENT_MEETING_DECISION_DRAFT_ACT_OR_NATIONAL_MATTER")
									: null
								}</p> : null}

								{links.length ? <ul class="event-links">
									{links.map((link) => <li>
										<UntrustedLink href={link.url}>{link.title}</UntrustedLink>
									</li>)}
								</ul> : null}
							</Fragment>
							break

						case "parliament-decision":
							title = t("PARLIAMENT_DECISION")

							summary = event.content.summary
							if (summary)
								content = <p class="text">{Jsx.html(linkify(summary))}</p>
							break

						case "parliament-letter":
							var letter = event.content
							summary = letter.summary

							title = letter.direction == "incoming"
								? t("PARLIAMENT_LETTER_INCOMING")
								: t("PARLIAMENT_LETTER_OUTGOING")

							content = <Fragment>
								<table class="event-table">
									<tr>
										<th scope="row">{t("PARLIAMENT_LETTER_TITLE")}</th>
										<td>{letter.title}</td>
									</tr>
									{letter.direction == "incoming" ? <tr>
										<th scope="row">{t("PARLIAMENT_LETTER_FROM")}</th>
										<td><ul>{splitRecipients(letter.from).map((from) => (
											<li>{from}</li>
										))}</ul></td>
									</tr> : <tr>
										<th scope="row">{t("PARLIAMENT_LETTER_TO")}</th>
										<td><ul>{splitRecipients(letter.to).map((to) => (
											<li>{to}</li>
										))}</ul></td>
									</tr>}
								</table>

								{summary && <p class="text">{Jsx.html(linkify(summary))}</p>}
							</Fragment>
							break

						case "parliament-interpellation":
							title = t("PARLIAMENT_INTERPELLATION")
							var interpellation = event.content
							var deadline = Time.parseIsoDate(interpellation.deadline)

							content = <Fragment>
								<table class="event-table">
									<tr>
										<th scope="row">{t("PARLIAMENT_INTERPELLATION_TO")}</th>
										<td>{interpellation.to}</td>
									</tr>
									<tr>
										<th scope="row">
											{t("PARLIAMENT_INTERPELLATION_DEADLINE")}
										</th>

										<td>{I18n.formatDate("numeric", deadline)}</td>
									</tr>
								</table>
							</Fragment>
							break

						case "parliament-national-matter":
							title = t("PARLIAMENT_NATIONAL_MATTER")
							break

						case "parliament-finished":
							decision = initiative.parliament_decision
							title = t("PARLIAMENT_FINISHED")

							if (decision) content = <p class="text">{
								decision == "return"
								? t("PARLIAMENT_DECISION_RETURN")
								: decision == "reject"
								? t("PARLIAMENT_DECISION_REJECT")
								: decision == "forward"
								? t("PARLIAMENT_DECISION_FORWARD")
								: decision == "forward-to-government"
								? t("PARLIAMENT_DECISION_FORWARD_TO_GOVERNMENT")
								: decision == "solve-differently"
								? t("PARLIAMENT_DECISION_SOLVE_DIFFERENTLY")
								: decision == "draft-act-or-national-matter"
								? t("PARLIAMENT_DECISION_DRAFT_ACT_OR_NATIONAL_MATTER")
								: null
								}</p>
							break

						case "sent-to-government":
							title = initiative.destination != "parliament"
								? t("EVENT_SENT_TO_LOCAL_GOVERNMENT_TITLE")
								: initiative.government_agency
								? t("EVENT_SENT_TO_GOVERNMENT_TITLE_WITH_AGENCY", {
									agency: initiative.government_agency
								})
								: t("EVENT_SENT_TO_GOVERNMENT_TITLE")
							break

						case "finished-in-government":
							title = !initiative.government_agency
								? t("EVENT_FINISHED_IN_GOVERNMENT_TITLE")
								: t("EVENT_FINISHED_IN_GOVERNMENT_TITLE_WITH_AGENCY", {
									agency: initiative.government_agency
								})

							if (initiative.government_decision) content = <p class="text">
								{t("EVENT_FINISHED_IN_GOVERNMENT_CONTENT", {
									decision: initiative.government_decision
								})}
							</p>
							break

						case "media-coverage":
							title = <UntrustedLink href={event.content.url}>
								{event.title}
							</UntrustedLink>

							authorName = event.content.publisher
							content = null
							break

						case "text":
							title = event.title
							authorName = event.origin == "author" ? event.user_name : null
							content = <p class="text">{Jsx.html(linkify(event.content))}</p>
							break

						default:
							throw new RangeError("Unsupported event type: " + event.type)
					}

					var files = event.files || EMPTY_ARR

          // No point in showing delay warnings for events that were created
          // before we started notifying people of new events.
          var delay = +event.created_at >= +EVENT_NOTIFICATIONS_SINCE
						? diffInDays(event.occurred_at, event.created_at)
						: 0

					return <li id={"event-" + event.id} class={klass}>
						<h2>{title}</h2>

						<div class="metadata">
							<time class="occurred-at" datetime={event.occurred_at.toJSON()}>
								<a href={`#event-${event.id}`}>
									{I18n.formatDate("numeric", event.occurred_at)}
								</a>
							</time>

							{authorName ? <Fragment>
								{", "}
								<span class="author">{authorName}</span>
							</Fragment> : null}
						</div>

						{content}

						{files.length > 0 ? <ul class="files">{files.map(function(file) {
							var type = file.content_type.name
							var title = file.title || file.name
							var filePath =`${initiativePath}/files/${file.id}`
							var icon = FILE_TYPE_ICONS[type] || "unknown"

							return <li class="file">
								<a href={filePath} tabindex="-1" class={"icon " + icon} />
								<a class="name" title={title} href={filePath}>{title}</a>

								<small class="type">{FILE_TYPE_NAMES[type] || type}</small>
								{", "}
								<small class="size">{I18n.formatBytes(file.size)}</small>
								{". "}

								{file.url ? <small><a class="external" href={file.url}>
									Riigikogu dokumendiregistris.
								</a></small> : null}
							</li>
						})}</ul> : null}

            {event.type == "text" && delay != 0 ? <p class="delay">
              {Jsx.html(t("EVENT_NOTIFICATIONS_DELAYED", {
                isotime: _.escapeHtml(event.created_at.toJSON()),
                date: _.escapeHtml(I18n.formatDate("numeric", event.created_at))
              }))}
            </p> : null}
					</li>
				})}</ol>
			</article>
		</center></section>

	else if (isPhaseAtLeast("parliament", initiative))
		return <section id="initiative-events" class="transparent-section"><center>
			<article><p class="text empty">{t("NO_GOVERNMENT_REPLY")}</p></article>
		</center></section>

	else return null
}

function CommentsView(attrs) {
	var {t} = attrs
	var {req} = attrs
	var {initiative} = attrs
	var {comments} = attrs
	var {subscription} = attrs

	return <section id="initiative-comments" class="transparent-section"><center>
		<h2>{t("COMMENT_HEADING")}</h2>

		<ol class="comments">
			{comments.map((comment) => <li
				id={`comment-${comment.id}`}
				class="comment">
				<CommentView req={req} initiative={initiative} comment={comment} />
			</li>)}
		</ol>

		<CommentForm
			req={req}
			id="comment-form"
			initiative={initiative}
			subscription={subscription}
			referrer={req.baseUrl + req.path}
		/>
	</center></section>
}

function SubscribeEmailView(attrs) {
	var {t} = attrs
	var {req} = attrs
	var {user} = req
	var {initiative} = attrs
	var {count} = attrs
	var {allCount} = attrs
	var counts = {count: count, allCount: allCount}

	return <Form
		req={req}
		class="initiative-subscribe-form"
		method="post"
		action={`/initiatives/${initiative.uuid}/subscriptions`}>
		{/* Catch naive bots */}
		<input name="e-mail" type="email" hidden />

    <input
      id="initiative-subscribe-email"
      name="email"
      type="email"
			value={user && (user.email || user.unconfirmed_email)}
      required
      placeholder={t("LBL_EMAIL")}
      class="form-input"
    />

    <button type="submit" class="secondary-button">{t("BTN_SUBSCRIBE")}</button>

		{count || allCount ? <p>
			{Jsx.html(
				count && allCount ? t("INITIATIVE_SUBSCRIBER_COUNT_BOTH", counts) :
				count > 0 ? t("INITIATIVE_SUBSCRIBER_COUNT", counts) :
				allCount > 0 ? t("INITIATIVE_SUBSCRIBER_COUNT_ALL", counts) :
				null
			)}
		</p> : null}
	</Form>
}

function ProgressTextView(attrs) {
	var {t} = attrs
	var {initiative} = attrs
	var {signatureCount} = attrs

	switch (initiative.phase) {
		case "edit":
			return <p class="initiative-progress-text">
				<span>
					{t("DISCUSSION_DEADLINE")}
					{": "}
					<time datetime={initiative.discussion_ends_at.toJSON()}>
						{I18n.formatDateTime(
							"numeric",
							DateFns.addMilliseconds(initiative.discussion_ends_at, -1)
						)}
					</time>
				</span>
			</p>

		case "sign":
			var signatureThreshold = getRequiredSignatureCount(initiative)
			var missing = signatureThreshold - signatureCount

			return <p class="initiative-progress-text">
				<span>
					{signatureCount >= signatureThreshold
						? Jsx.html(t("SIGNATURES_COLLECTED_FOR_" + initiative.destination))
						: Jsx.html(t("MISSING_N_SIGNATURES_FOR_" + initiative.destination, {
							signatures: missing
						}))
					}
				</span>
				{" "}
				<span>
					{t("VOTING_DEADLINE")}
					{": "}
					<time datetime={initiative.signing_ends_at.toJSON()} class="deadline">
						{I18n.formatDateTime(
							"numeric",
							DateFns.addMilliseconds(initiative.signing_ends_at, -1)
						)}
					</time>.
				</span>
			</p>

		default: return null
	}
}

function QuicksignView(attrs) {
	var {t} = attrs
	var {req} = attrs
	var {initiative} = attrs
	var {signature} = attrs
	var {signatureCount} = attrs

	if (!initiative.published_at) return null

	return <div class={"quicksign " + (attrs.class || "")}>
		<ProgressView
			t={t}
			initiative={initiative}
			signatureCount={signatureCount}
		/>

		{Initiative.isSignable(new Date, initiative) && !signature ? <a
			href="#initiative-vote"
			class="green-button wide-button sign-button">
			{t("SIGN_THIS_DOCUMENT")}
			</a>
		: null}

		<ProgressTextView
			t={t}
			initiative={initiative}
			signatureCount={signatureCount}
		/>

		{Initiative.isSignable(new Date, initiative) && signature ? <Fragment>
			<h2>{t("THANKS_FOR_SIGNING")}</h2>

			<DownloadSignatureButton signature={signature}>
				{t("DOWNLOAD_SIGNATURE")}
			</DownloadSignatureButton>

			<span class="form-or">{t("FORM_OR")}</span>

			<DeleteSignatureButton req={req} signature={signature}>
				{t("REVOKE_SIGNATURE")}
			</DeleteSignatureButton>
		</Fragment> : null}
	</div>
}

function InitiativeDestinationSelectView(attrs) {
	var {initiative} = attrs
	var dest = initiative.destination
	var {placeholder} = attrs

	return <select
		name={attrs.name}
		class={attrs.class}
		onchange={attrs.onchange}
	>
		<option value="" selected={dest == null}>{placeholder}</option>

		<optgroup label="Riiklik">
			<option value="parliament" selected={dest == "parliament"}>
				Riigikogu
			</option>
		</optgroup>

		{_.map(LOCAL_GOVERNMENTS_BY_COUNTY, (govs, county) => (
			<optgroup label={county + " maakond"}>{govs.map(([id, name]) => (
				<option value={id} selected={dest == id}>
					{name}
				</option>
			))}</optgroup>
		))}
	</select>
}

function InitiativeLocationView(attrs) {
	var {t} = attrs
	var {initiative} = attrs

	var content
	if (initiative.phase == "parliament" && initiative.parliament_committee) {
		content = <Fragment>
			{Jsx.html(t("INITIATIVE_IS_IN_PARLIAMENT_COMMITTEE", {
				committee: _.escapeHtml(initiative.parliament_committee)
			}))}
		</Fragment>
	}
	else if (initiative.phase == "government" && initiative.government_agency) {
		content = <Fragment>
			{Jsx.html(t("INITIATIVE_IS_IN_GOVERNMENT_AGENCY", {
				agency: _.escapeHtml(initiative.government_agency)
			}))}<br />

			{initiative.government_contact ? <Fragment>
				<br />
				<strong>{t("GOVERNMENT_AGENCY_CONTACT")}</strong>:<br />
				{initiative.government_contact}<br />
				{Jsx.html(linkify(initiative.government_contact_details || ""))}
			</Fragment> : null}
		</Fragment>
	}

	if (content == null) return null
	else return <p id="initiative-location">{content}</p>
}

function InitiativeAttribute(attrs, children) {
	var {t} = attrs
	var {title} = attrs
	var {type} = attrs
	var {name} = attrs
	var {value} = attrs
	var {placeholder} = attrs
	var {help} = attrs
	var {editable} = attrs
	var {maxlength} = attrs

	return <Fragment>
		<h3 class="sidebar-subheader">{title}</h3>
		{value ? children : <AddInitiativeInfoButton t={t} /> }

		{editable ? <div class="form-fields">
			{type == "textarea" ? <textarea
				name={name}
				class="form-textarea"
				maxlength={maxlength}
				placeholder={placeholder}>
				{value}
			</textarea> : <input
				name={name}
				type={type}
				class="form-input"
				placeholder={placeholder}
				value={value}
				maxlength={maxlength}
			/>}

			{help ? <p>{help}</p> : null}
		</div> : null}
	</Fragment>
}

function InitiativeAttributeList(attrs, children) {
	var {id} = attrs
	var {values} = attrs
	var def = attrs.default
	var {add} = attrs
	var {help} = attrs
	var render = children[0]
	var buttonId = _.uniqueId("initiative-attributes-")

	return <div id={id} class="form-fields">
		{help ? <p>{help}</p> : null}

		<ol class="form-list">
			{(values.length > 0 ? values : [def]).map(render)}
		</ol>

		<button type="button" id={buttonId}>{add}</button>

		<script>{javascript`
			var button = document.getElementById(${buttonId})
			var list = button.previousSibling
			var each = Function.call.bind(Array.prototype.forEach)

			button.addEventListener("click", function(ev) {
				var el = list.lastChild.cloneNode(true)
				list.appendChild(el)
				var inputs = el.getElementsByTagName("input")

				each(inputs, function(input) {
					input.name = incrementName(input.name)
					input.value = ""
				})

				inputs[0].focus()
			})

			function incrementName(name) {
				return name.replace(/\\[(\\d+)\\]/g, function(_all, n) {
					return "[" + (+n + 1) + "]"
				})
			}
		`}</script>
	</div>
}

function UntrustedLink(attrs, children) {
	var {href} = attrs
	var klass = attrs.class || ""
	children = children ? children.filter(Boolean) : EMPTY_ARR
	var text = children.length ? children : href

	if (HTTP_URL.test(href)) return <a {...attrs} class={klass + " link-button"}>
		{text}
	</a>
	else return <span class={klass}>{text}</span>
}

function InitiativeImageUploadForm(attrs, children) {
	var {req} = attrs
	var {initiative} = attrs
	var initiativePath = "/initiatives/" + initiative.uuid

	return <Form
		id={attrs.id}
		class={attrs.class}
		req={req}
		action={initiativePath + "/image"}
		method="put"
		enctype="multipart/form-data"
	>
		<label>
			<input
				type="file"
				name="image"
				required
				hidden
				accept="image/jpeg, image/png"
				onchange="this.form.submit()"
			/>

			{children}
		</label>
	</Form>
}

function AddInitiativeInfoButton(attrs) {
	var {t} = attrs

	return <label
		class="edit-button link-button"
		for="initiative-info-form-toggle">
		{t("ADD_INITIATIVE_INFO")}
	</label>
}

function DownloadSignatureButton(attrs, children) {
	var {signature} = attrs
	var initiativePath = "/initiatives/" + signature.initiative_uuid
	var signaturePath = initiativePath + "/signatures/"
	signaturePath += pathToSignature(signature, "asice")

	return <a class="link-button download-button" href={signaturePath} download>
		{children}
	</a>
}

function DeleteSignatureButton(attrs, children) {
	var {req} = attrs
	var {signature} = attrs
	var initiativePath = "/initiatives/" + signature.initiative_uuid

	return <FormButton
		req={req}
		formClass="revoke-button"
		class="link-button"
		action={initiativePath + "/signatures/" + pathToSignature(signature)}
		onclick={confirm(req.t("REVOKE_SIGNATURE_CONFIRMATION"))}
		name="_method"
		value="delete">
		{children}
	</FormButton>
}

function isPhaseAtLeast(than, phase) {
	return PHASES.indexOf(phase) >= PHASES.indexOf(than)
}

function isPhaseAfter(than, phase) {
	return PHASES.indexOf(phase) > PHASES.indexOf(than)
}

function initiativePhaseFromEvent(event) {
	switch (event.type) {
		case "signature-milestone": return "sign"
		case "sent-to-parliament":
		case "parliament-received":
		case "parliament-accepted":
		case "parliament-letter":
		case "parliament-interpellation":
		case "parliament-national-matter":
		case "parliament-board-meeting":
		case "parliament-committee-meeting":
		case "parliament-plenary-meeting":
		case "parliament-decision":
		case "parliament-finished": return "parliament"
		case "sent-to-government": return "government"
		case "finished-in-government": return "government"
		case "text":
		case "media-coverage": return null
		default: throw new RangeError("Unsupported event type: " + event.type)
	}
}

var EVENT_ORDER = [
	"sent-to-parliament",
	"parliament-received",
	"parliament-accepted",
	"parliament-finished",
	"sent-to-government",
	"finished-in-government"
]

// This comparison function is not transitive, but works with
// Array.prototype.sort's implementation.
function compareEvent(a, b) {
	if (EVENT_ORDER.includes(a.type) && EVENT_ORDER.includes(b.type))
		return EVENT_ORDER.indexOf(a.type) - EVENT_ORDER.indexOf(b.type)
	else
		return +a.occurred_at - +b.occurred_at
}

function renderImageAuthor(image) {
	var name = image.author_name, url = image.author_url
	if (name && url) return <UntrustedLink class="author" href={url}>
		{name || null}
	</UntrustedLink>

	if (name) return <span class="author">{name}</span>

	if (url) return <UntrustedLink class="author" href={url}>
		{getUrlHost(url)}
	</UntrustedLink>

	return null

	function getUrlHost(url) {
		try { return Url.parse(url).hostname }
		catch (_ex) { return null }
	}
}

function splitRecipients(recipients) { return recipients.split(/[;,]/) }
