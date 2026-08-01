/**
 * draftLibrary.data.js
 * Contract: _contracts/04-drafting-lab.md ("Step 1 Content Source")
 *
 * Step 1 (View & Learn) content — no AI, unlimited, $0. Hardcoded/founder-reviewable
 * on purpose (see contract): a small, fixed set (5 draft types x 2 states) that
 * doesn't need a database table behind it.
 *
 * SOURCING: compiled 2026-07-23 from public court websites, official court rules,
 * and law-school drafting-course material. Every specimen below is labeled with a
 * confidence rating — nothing here was invented to fill a gap. Where the real,
 * official document could not be verified or extracted (e.g. a scanned PDF with no
 * text layer), that is stated plainly in `note`, and a genuine practice-equivalent
 * is used instead and marked GENERIC_FALLBACK. See _decisions/decisions-log.md for
 * the full research trail and confidence methodology.
 *
 * CONFIDENCE LEVELS:
 *   HIGH            - a real, identifiably state-specific document: real court,
 *                      real names/addresses/case numbers, or an official
 *                      government/court form with verified text.
 *   MODERATE /
 *   MODERATE_HIGH   - genuinely from that state's legal-education/practice
 *                      material, but with a caveat (e.g. cites pre-2023 CrPC
 *                      numbering instead of BNSS, or hosted on an aggregator that
 *                      only allowed partial verbatim extraction).
 *   GENERIC_FALLBACK - no meaningfully state-specific version exists or could be
 *                      read; substituting a generic/pan-India equivalent, with
 *                      `note` explaining why.
 *
 * IMPORTANT: `text` blocks are excerpted/condensed specimens for teaching
 * structure and anatomy, not certified full-text reproductions of court filings.
 * Every entry carries `sourceUrl` so a student (or a founder) can pull the
 * original document directly.
 */

const draftLibrary = [
  // ─────────────────────────────────────────────────────────────────────────
  {
    template_type: 'vakalatnama',
    label: 'Vakalatnama',
    anatomy: [
      { part: 'Court heading', why: 'Names the exact court the vakalatnama is being filed in — must match the case it belongs to.' },
      { part: 'Appointment clause ("KNOW ALL...")', why: 'The core legal act: the client formally appoints a named advocate to represent them.' },
      { part: 'Numbered list of powers granted', why: 'Vakalatnamas are not blank trust — they enumerate exactly what the advocate may do (appear, file documents, accept money, compromise, etc.). Courts and opposing counsel rely on this list.' },
      { part: 'Ratification clause', why: 'The client agrees in advance to be bound by the advocate\'s lawful acts done under this authority — protects the advocate from later disputes about authority.' },
      { part: 'Fee/withdrawal clause', why: 'States the advocate may withdraw from the case if fees remain unpaid — a standard protective clause for the advocate.' },
      { part: 'Signatures (client + advocate) and date', why: 'Without both signatures the document has no legal effect.' },
    ],
    specimens: {
      delhi: {
        confidence: 'HIGH',
        text:
`IN THE HIGH COURT OF DELHI AT NEW DELHI

KNOW ALL to whom these presents shall come that I/We ... do hereby
appoint Mr./Mrs./Ms./Mx ... Advocate(s), having office at ..., by
him/her/them:-

(1) To act, appear and plead in the above noted case in this Court,
    or any other Court to which the same may be transferred...
(2) To accept notice/process of Court on my behalf.
(3) To sign, file and present all pleadings, replications,
    rejoinders, appeals, cross-objections, petitions, counter
    affidavits, objections, affidavits, applications...
(4) To file and take back documents.
(5) To withdraw or compromise the said case.
(6) To take out execution proceedings.
(7) To deposit, withdraw and receive moneys, cheques and other
    instruments and grant receipts therefor.
(8) To do all other acts and things as may be deemed necessary...
(9) To appoint and instruct another advocate(s)...

And I/We do hereby agree to ratify and confirm all acts done by the
Advocate... and agree not to hold the Advocate(s) responsible for
the result of the said case... and that in the event of the whole
or any part of the fee agreed remaining unpaid, he shall be
entitled to withdraw from the prosecution of the said case until
the same is paid up.

{This is a suggested proforma. Parties are free to vary its terms
and conditions}`,
        sourceUrl: 'https://delhihighcourt.nic.in/files/announcements/downloadfile_adupync8.pdf',
        sourceLabel: 'Delhi High Court — Vakalatnama (official PDF)',
        note: 'The official PDF also carries a parallel Hindi version on the same page, not reproduced here.',
        // Real PDF, viewable/downloadable by students. Uploaded to S3 by
        // backend/scripts/seedDraftLibraryPdfs.js — see that script for the
        // upload step (not runnable from the build sandbox, see decisions-log).
        sourcePdfS3Key: 'draft-library/vakalatnama/delhi.pdf',
      },
      maharashtra: {
        confidence: 'GENERIC_FALLBACK',
        text:
`VAKALATNAMA

The above named ... do hereby appoint ... Advocate/s, and authorize
him:-
1. To act, appear and plead in the above-noted case... and in all
   proceedings (appeal, revision, review) in the High Court and
   Supreme Court, subject to separate fee.
2. To sign, file, verify and present pleadings, appeals, petitions
   for execution, review, revision, withdrawal, compromise...
3. To file and take back documents, admit/deny opposite party's
   documents.
4. To withdraw or compromise, or submit to arbitration...
5. To deposit, draw and receive money, cheques and cash...
6. To appoint and instruct any other legal practitioner...

AND I/We agree — (a) adjournment costs belong to the Advocate;
(b) Advocate may withdraw on unpaid fees; (c) no refund of fee paid;
(d) renewal of fee if case exceeds 3 years; (e) not to hold the
Advocate responsible for the result.`,
        sourceUrl: 'https://ecourts.gov.in/ecourts_home/forms/Vakalatnama%20form.pdf',
        sourceLabel: 'eCourts.gov.in — Vakalatnama (national practice-equivalent used across Maharashtra district courts)',
        note: 'The true official Maharashtra form — Bombay HC Original Side Rules 1980, "Form No. 5" (Rule 49(b)) — exists at a confirmed URL but is a scanned image PDF with no extractable text layer, so its exact wording could not be verified. Using the eCourts national practice form instead, clearly labeled as not certified identical to Form No. 5. Official (unreadable) source: https://bombayhighcourt.gov.in/bhc/libweb/bhcrule/OSRules/forms/No.5.pdf',
        sourcePdfS3Key: 'draft-library/vakalatnama/maharashtra-ecourts-practice-form.pdf',
        // The real official (scanned, unreadable) Form No. 5 is stored too —
        // shown in the UI as "view the official scanned form" alongside the
        // practice-equivalent above, never in place of the honesty note.
        scannedOfficialPdfS3Key: 'draft-library/vakalatnama/maharashtra-form5-official-scanned.pdf',
      },
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    template_type: 'affidavit',
    label: 'Affidavit',
    anatomy: [
      { part: 'Cause title', why: 'Names the court and the parties (Petitioner v. Respondent) the affidavit is filed in support of.' },
      { part: 'Deponent identification', why: 'Full name, parentage, age, address of the person swearing the affidavit — establishes who is legally accountable for its contents.' },
      { part: 'Numbered statements of fact', why: 'Each fact the deponent swears to, stated plainly and individually so each can be verified or challenged separately.' },
      { part: 'Verification clause', why: 'The formal declaration that the contents are true to the deponent\'s knowledge and belief, and that nothing material has been concealed — this is what makes an affidavit different from an ordinary statement.' },
      { part: 'Oath/affirmation wording', why: 'Prescribed by court rules — the exact words the deponent swears/affirms before the attesting officer.' },
      { part: 'Attesting officer\'s certificate + signature', why: 'An affidavit has no legal force until a notary/oath commissioner/court officer certifies it was sworn before them.' },
    ],
    specimens: {
      delhi: {
        confidence: 'MODERATE_HIGH',
        text:
`IN THE HIGH COURT OF DELHI AT NEW DELHI
IN THE MATTER OF: BALJEET SINGH MALIK @ POPPY ... PETITIONER
VERSUS   STATE [GOVT. OF NCT OF DELHI] ... RESPONDENT

AFFIDAVIT

I, Rajender Malik S/o Shri Dharamvir Malik, aged about 33 years,
R/O H.No.161, A-Block, Village: Masoodpur, Vasant Kunj, New Delhi-70,
do hereby solemnly affirm and state as under:

1. That I am the elder brother/authorized representative of the
   Petitioner above named and am competent and conversant with the
   facts to swear this affidavit.
2. That the contents of the accompanying petition have been read
   over and explained to me in vernacular, and are true and correct
   to the best of my knowledge and belief.
3. That the annexures filed are true/typed/translated copies of
   their respective originals.

VERIFICATION: Verified today the 25th day of January, 2019 that the
contents of the present affidavit are true and correct as per my
knowledge and belief. Nothing is false, nor anything material has
been concealed therefrom.
                                                        DEPONENT

--- Delhi High Court Rules, Chapter 12 (prescribed oath wording) ---
OATH: "I solemnly swear that this my declaration is true, that it
conceals nothing, and that no part of it is false — so help me God!"
AFFIRMATION: "I solemnly affirm that this my declaration is true,
that it conceals nothing, and that no part of it is false."
ATTESTING OFFICER'S CERTIFICATE: "Certified that the above was
declared on [date] before me this [day] of [month], at [place] in
the district of [district] by [declarant's name/description]..."`,
        sourceUrl: 'https://images.assettype.com/barandbench/import/2019/01/Writ-Petition-Baljeet-Malik-vs-State.pdf',
        sourceLabel: 'Baljeet Singh Malik affidavit, Delhi HC (Bar & Bench) + Delhi HC Rules Ch.12',
        note: 'Real filed affidavit for the case caption/parties/verification; oath wording separately sourced from the Delhi High Court Rules (https://delhihighcourt.nic.in/files/2024-04/courtrulefile_r43dp25p.pdf).',
        sourcePdfS3Key: 'draft-library/affidavit/delhi.pdf',
        supportingPdfS3Key: 'draft-library/affidavit/delhi-hc-rules-ch12-oaths.pdf',
      },
      maharashtra: {
        confidence: 'HIGH',
        text:
`IN THE HIGH COURT OF JUDICATURE AT BOMBAY
ORDINARY ORIGINAL CIVIL JURISDICTION
Chamber Summons No. ___ of 2017
In Public Interest Litigation (Lodg.) No. 46 OF 2017

AFFIDAVIT IN SUPPORT OF CHAMBER SUMMONS

I, Dr. B. Veeranna, aged 63 years, residing at [address], the
authorized signatory of the above named Applicant No. 1, do hereby
solemnly affirm and state as under: [24 numbered paragraphs]

Solemnly affirmed at ___________ )
On this ______ day of June, 2017 )
Before me
Identified by me
(Advocate for the Applicants)

--- separately, from a Mumbai probate/succession affidavit set ---
I, [ ] the Petitioner abovenamed do solemnly declare that what is
stated in paragraphs 1 to 10 is true to my own knowledge.
Declared at Mumbai
Before me
Assistant Master/Associate, High Court, Bombay`,
        sourceUrl: 'https://clpr.org.in/wp-content/uploads/2017/06/Online-Version-Final-Chamber-Summons-1.pdf',
        sourceLabel: 'Real Bombay HC PIL affidavit (CLPR) + Mumbai probate/succession affidavit set (propsamc.com)',
        note: 'The exact official "Form No. 3" verification text (Rule 44, Bombay HC Original Side Rules) is only available as a scanned, non-OCR\'able page — this specimen uses real filed Bombay HC affidavits instead, which carry the distinctive OOCJ caption and "Assistant Master/Associate, High Court, Bombay" attesting title unique to Bombay practice.',
        sourcePdfS3Key: 'draft-library/affidavit/maharashtra.pdf',
      },
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    template_type: 'bail_application',
    label: 'Bail Application (Regular, Post-Arrest)',
    anatomy: [
      { part: 'Court heading + case/FIR number', why: 'Identifies exactly which court and which criminal case (FIR, sections charged) the application belongs to.' },
      { part: '"Most respectfully showeth" narrative paragraphs', why: 'Numbered factual paragraphs building the case for bail: personal background, nature of the allegation, why continued custody isn\'t necessary, cooperation with investigation.' },
      { part: 'Grounds for bail', why: 'The specific legal/factual reasons bail should be granted — e.g. no flight risk, no tampering risk, parity with co-accused, prior clean record.' },
      { part: 'Citation of precedent', why: 'Bail applications lean heavily on Supreme Court precedent (e.g. the presumption of innocence, bail-not-jail principle) to support the prayer.' },
      { part: 'Prayer clause', why: 'States exactly what the applicant is asking the court to order — plain, specific, and separate from the narrative above it.' },
      { part: 'Verification', why: 'A sworn declaration that the facts stated in the application are true.' },
    ],
    specimens: {
      delhi: {
        confidence: 'MODERATE',
        text:
`COURT: District & Sessions Judge, Saket Court, South District, New Delhi
BAIL APPLICATION NO. ___ OF 2021
UNDER SECTION 439 CR.P.C. FOR GRANT OF REGULAR BAIL
Charges: S.3/7 Essential Commodities Act 1955; S.3 Epidemic Diseases
Act 1897; S.420/468/471/188/120B/34 IPC

MOST RESPECTFULLY SHOWETH:
1. That the applicant is a law-abiding citizen... seeking regular
   bail.
2. That the applicant approached the Ld. CMM for regular bail, which
   was dismissed on ___ (Annexure-A).
3-5. [detailed facts of the alleged offence and licensing dispute]
[... continues through 32 numbered paragraphs, citing D.K. Basu v.
State of WB, Arnesh Kumar v. State of Maharashtra, Sanjay Chandra
v. CBI, Rajiv Kumar v. State of UP, Suresh v. State of UP]

PRAYER: (a) release on regular bail on such terms as the Court
deems fit; (b) grant interim bail for 90 days pending disposal;
(c) any other order deemed fit.`,
        sourceUrl: 'https://lawvs.com/drafts/bail-application-on-behalf-of-applicant-petitioner-u-s-439-of-cr-p-c-54',
        sourceLabel: 'lawvs.com bail draft, captioned Saket Court',
        note: 'Cites CrPC S.439 — the pre-2023 law. Voxera For Law correctly cites the current BNSS S.483 in its own template; no genuine Delhi specimen citing the new BNSS numbering could be confirmed, only generic AI-style templates, so this real (older-numbered) court-anchored specimen is used for structure/anatomy purposes.',
      },
      maharashtra: {
        confidence: 'MODERATE_HIGH',
        text:
`IN THE COURT OF ____, ADDITIONAL DISTRICT AND SESSION JUDGE,
IN THE MATTER OF: LMN ... Petitioner   Versus   State of _____ ...
Respondent

Most Respectfully Show:
1. That the present application under section 439 of the Code of
   Criminal Procedure 1973 is being filed for grant of regular bail.
2. That the Petitioner is innocent and is being falsely implicated.
3-8. [law-abiding citizen, responsible person, other relevant
   facts, no useful purpose served by detention, undertaking to
   abide by conditions, no other similar petition filed]

PRAYER: (a) grant bail in connection with FIR No. ___ u/s ___;
(b) any other order in the interest of justice.

[Closing reference to Sections 82/88 CrPC, S.21 General Clauses Act,
and a Bombay High Court judgment on warrant cancellation, noting
the practice "particularly in the city of Bombay."]`,
        sourceUrl: 'https://www.studocu.com/in/document/university-of-mumbai/practical-training/bail-application-draft-for-practical/109731242',
        sourceLabel: 'University of Mumbai Practical Training — bail application draft',
        note: 'Genuine Mumbai/Maharashtra legal-education material, not a generic blog template — the Bombay High Court judgment reference and "city of Bombay" framing are real Maharashtra markers. Also cites pre-BNSS CrPC S.439.',
      },
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    template_type: 'anticipatory_bail',
    label: 'Anticipatory Bail Application',
    anatomy: [
      { part: 'Court heading + FIR/case number', why: 'Same as a regular bail application — identifies the exact case, but filed BEFORE arrest, on apprehension of arrest.' },
      { part: 'Apprehension-of-arrest paragraph', why: 'The core distinguishing element: the applicant must state specifically why they believe/apprehend imminent arrest.' },
      { part: 'Assertion of false implication / innocence', why: 'Standard grounds paragraph arguing the allegation is unfounded or motivated.' },
      { part: 'Cooperation undertaking', why: 'A promise to join and cooperate with the investigation if granted anticipatory bail — reassures the court custody isn\'t needed to secure cooperation.' },
      { part: 'No flight risk / no tampering risk paragraph', why: 'Directly addresses the two things courts weigh most heavily in bail decisions.' },
      { part: 'Prayer + verification', why: 'Same structure as regular bail — a specific ask, sworn true.' },
    ],
    specimens: {
      delhi: {
        confidence: 'MODERATE',
        text:
`IN THE COURT OF SESSIONS JUDGE (DISTRICT ___), DELHI / TIS HAZARI
COURTS DELHI
ANTICIPATORY BAIL APPLICATION NO. ___ OF 2017
X ___ S/o ___ R/o ___ ..... Applicant   VERSUS   State ..... Complainant
FIR No. ___ of 2017, U/S ___, P.S. ___

"APPLICATION FOR THE GRANT OF ANTICIPATORY BAIL UNDER SECTION 438 OF
THE CODE OF CRIMINAL PROCEDURE, 1973"
[12 paragraphs: applicant's details, character, relationship with
complainant's family, the alleged incident, claim of a false FIR,
assertion of innocence, apprehension of arrest, police visits,
undertaking to cooperate, no flight risk, no prior record.]`,
        sourceUrl: 'https://www.studocu.com/in/document/amity-university/drafting-pleading-conveyance-clinical-paper-ii/anticipatory-bail-format/11625493',
        sourceLabel: 'District Courts Delhi anticipatory bail format (Studocu, Amity University drafting course)',
        note: 'Cites CrPC S.438 — the pre-2023 law (Voxera For Law\'s own template correctly cites the current BNSS S.482). Real Delhi court naming convention (Tis Hazari Courts) preserved for structure.',
      },
      maharashtra: {
        confidence: 'MODERATE_HIGH',
        text:
`IN THE COURT OF SESSIONS, GREATER MUMBAI AT MUMBAI
(Criminal Appellate/Miscellaneous Jurisdiction)
Applicant ..... vs ..... State of Maharashtra

"THE HUMBLE APPLICATION OF THE APPLICANT ABOVENAMED"
[11 points: residency in Mumbai, innocence, lack of evidence,
readiness to cooperate, "question of jumping bail and/or
tampering with prosecution witnesses does not arise."]
PRAYER: bail on arrest + interim protection pending hearing.
VERIFICATION: sworn declaration.`,
        sourceUrl: 'https://www.studocu.com/in/document/university-of-mumbai/practical-training/blank-aba-formet-draft-for-practical/109731246',
        sourceLabel: 'University of Mumbai Practical Training — anticipatory bail application (ABA) draft',
        note: 'Explicitly names "State of Maharashtra" and "Court of Sessions, Greater Mumbai at Mumbai" — the clearest genuine state-level naming-convention difference from the Delhi specimen.',
      },
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    template_type: 'legal_notice',
    label: 'Legal Notice',
    anatomy: [
      { part: 'Sender letterhead (advocate name, chambers, contact)', why: 'A legal notice must clearly identify who is sending it and on whose behalf.' },
      { part: 'Addressee block + reference/date', why: 'Identifies exactly who the notice is served on, and when — starts any statutory notice-period clock.' },
      { part: 'Subject line', why: 'One line stating what the notice concerns, so the recipient immediately knows the topic.' },
      { part: 'Numbered statement of facts', why: 'Lays out the factual background the demand is based on — dates, amounts, agreements, the breach or wrong being alleged.' },
      { part: 'The demand', why: 'States precisely what the recipient must do (pay an amount, vacate premises, cease an action) — vague demands weaken a notice.' },
      { part: 'Compliance deadline', why: 'A specific number of days from receipt, after which the sender states what consequence (legal proceedings, complaint) will follow.' },
      { part: 'Closing + advocate signature', why: 'Formal sign-off identifying the advocate who is legally responsible for having sent the notice.' },
    ],
    specimens: {
      delhi: {
        confidence: 'MODERATE_HIGH',
        text:
`Advocate: Amaresh Kumar Singh, practicing at the Supreme Court and
Delhi High Court; 579, Lawyers Chambers Block, Saket Court Complex,
Sector 6, Pushp Vihar, New Delhi
Addressee: M/s ABC Pvt Ltd / Mr. Mayank (Managing Director)
Basis: Section 138, Negotiable Instruments Act, 1881

Facts: supply of a 500 KVA Voltage Stabilizer + Lubricant Oil worth
Rs.7,08,000; cheque no. 450923 dishonoured ("Payment Stopped by
Drawer", bank memo dated 05.06.2024); failed recovery attempts.

Demand: remit "Rs. 7,08,000/- within a period of 15 (fifteen) days
from the date of receipt of this notice," failing which "criminal
proceedings against you the Noticees under section 138 of
Negotiable Instruments Act, 1881" would follow.`,
        sourceUrl: 'https://advocatesclub.in/legal-drafts-samples/cheque-bounce/legal-demand-notice/',
        sourceLabel: 'Advocates Club — Delhi cheque-bounce legal notice',
        note: 'Real advocate chamber address and real drafting facts. The notice\'s legal structure (facts -> demand -> deadline -> consequence) doesn\'t itself vary by state — no court or Bar Council prescribes a legal-notice format anywhere in India.',
      },
      maharashtra: {
        confidence: 'GENERIC_FALLBACK',
        text:
`ADVOCATE OFFICE / Address / Contact / Email
Ref. No. ___    Dated: ___    REGISTERED A.D.
To, (Name and Address of Recipient)
Sub: Legal Notice for eviction and recovery of rent

Under instructions from and on behalf of my client ___, I serve
upon you the following notice:
1. That my client is the owner of premises SCO No.___...
2. That my client let out the premises to you on a monthly rent
   of ___/- per month...
3-6. [rent default, arrears history, breach of tenancy terms]
7. [reason/right to evict]

I therefore call upon you to pay the due rent along with
maintenance and interest, and vacate the premises within ___ days
from receipt, failing which legal proceedings will be filed against
you at your own risk, cost and consequences.
Yours faithfully, (Advocate for the client)`,
        sourceUrl: 'https://blog.ipleaders.in/legal-notice-format/',
        sourceLabel: 'iPleaders — legal notice format (structural reference)',
        note: 'A dedicated search found no meaningfully Maharashtra-specific legal notice specimen — every published example uses blanket placeholders with no real Mumbai address, advocate name, or Bombay HC reference in the notice\'s own text. This is a genuine finding (legal notices carry no state-specific or court-prescribed format anywhere in India), not a shortcut — using the fullest available generic structural specimen instead, clearly labeled.',
      },
    },
  },
];

module.exports = { draftLibrary };
