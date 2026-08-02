/**
 * ResumeBuilderPage.jsx
 *
 * Theme: near-black background, warm parchment-grey text (deliberately NOT
 * white — a stark white-on-black reads as a generic app; a warm grey reads
 * as print/editorial, closer to a law firm's own letterhead). Display serif
 * (Playfair Display) for headings, body serif (Source Serif 4) for labels
 * and inputs, with a single restrained brass/antique-gold accent reserved
 * for primary actions, focus states, and the AI Enhance feature — spending
 * the one "bold" choice in one place rather than scattering it (see the
 * `--rb-accent` custom property below). This is the app UI theme — kept
 * intentionally distinct from the maroon/navy PDF resume templates
 * themselves, which are a separate design system entirely.
 *
 * Responsive via CSS Grid (`repeat(auto-fit, minmax(...))`) rather than
 * device-specific breakpoints, so it reflows naturally on iOS Safari,
 * Android Chrome, and desktop Windows/Mac browsers without special-casing
 * any of them.
 *
 * No daily limit on Build (see _contracts/07-resume-builder.md) — the button
 * is only ever disabled by incomplete compulsory sections, never by a count.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getTemplates, getDraft, saveDraft, buildResume, getBuildResult,
  uploadPhotoToS3, enhanceText, getResumeHistory,
} from '../services/resumeBuilder.service';

// Small color swatches so the picker itself hints at each template's look,
// without needing to render a full PDF preview just to choose one.
const TEMPLATE_SWATCHES = {
  law_resume_v1: '#7B1E3A',
  charcoal_modern: '#2b2b2b',
  monochrome_minimal: '#000000',
  emerald_classic: '#1B4332',
  bold_banner: '#1B263B',
  navy_sidebar: '#1B263B',
  executive_boxed: '#1a1a1a',
  olive_sidebar: '#6B7A3A',
  charcoal_split: '#2b2b2b',
  boxed_monochrome: '#ececec',
  olive_pro: '#77803B',
  slate_chevron: '#3B3B3B',
};

const EMPTY_DRAFT = {
  personal_info: { full_name: '', email: '', phone: '', target_field: '', city_country: '', linkedin: '', photo_key: '' },
  profile_summary: '',
  education: [{ institution: '', degree: '', year: '', gpa: '', coursework: '', honors: '' }],
  experience: [],
  // Volunteer & pro bono work mirrors the experience entry shape on purpose —
  // "Coordinated legal aid clinic serving 50+ clients" belongs in a full entry
  // (org / role / duration / bullets), not a one-line afterthought.
  volunteer: [],
  skills: { legal: '', advocacy: '', research_tools: '', drafting: '', software: '', soft_skills: '' },
  achievements: '',
  // Certifications got their own section (previously buried inside Bar
  // Admissions) — legal research / negotiation / Coursera / SCC courses are
  // high-value for law students and deserve their own heading on the PDF.
  certifications: '',
  bar_admissions: '',
  languages: '',
};

const SKILL_LABELS = {
  legal: 'Legal', advocacy: 'Advocacy', research_tools: 'Research Tools',
  drafting: 'Drafting', software: 'Software', soft_skills: 'Soft Skills',
};

const SECTION_LABELS = {
  personal_info: 'Personal Info', education: 'Education', skills: 'Skills',
  experience: 'Experience', achievements: 'Achievements',
};

// The backend stores skills/achievements/bar_admissions/languages as arrays;
// the form edits them as plain comma/newline-separated text for a simpler
// typing experience, converted at the save boundary.
const toArray = (text, sep = '\n') => text.split(sep).map((s) => s.trim()).filter(Boolean);
const toText = (arr, sep = '\n') => (Array.isArray(arr) ? arr.join(sep) : '');

const draftToWire = (d) => ({
  personal_info: d.personal_info,
  profile_summary: d.profile_summary,
  education: d.education,
  experience: d.experience.map((e) => ({ ...e, bullets: toArray(e.bulletsText || '') })),
  volunteer: d.volunteer.map((e) => ({ ...e, bullets: toArray(e.bulletsText || '') })),
  skills: Object.fromEntries(Object.entries(d.skills).map(([k, v]) => [k, toArray(v, ',')])),
  achievements: toArray(d.achievements),
  certifications: toArray(d.certifications),
  bar_admissions: toArray(d.bar_admissions),
  languages: toArray(d.languages, ','),
});

const wireToDraft = (w) => ({
  personal_info: { ...EMPTY_DRAFT.personal_info, ...(w?.personal_info || {}) },
  profile_summary: w?.profile_summary || '',
  education: w?.education?.length ? w.education : EMPTY_DRAFT.education,
  experience: (w?.experience || []).map((e) => ({ ...e, bulletsText: toText(e.bullets) })),
  volunteer: (w?.volunteer || []).map((e) => ({ ...e, bulletsText: toText(e.bullets) })),
  skills: Object.fromEntries(Object.keys(SKILL_LABELS).map((k) => [k, toText(w?.skills?.[k] || [], ', ')])),
  achievements: toText(w?.achievements),
  certifications: toText(w?.certifications),
  bar_admissions: toText(w?.bar_admissions),
  languages: toText(w?.languages, ', '),
});

export default function ResumeBuilderPage() {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [completeness, setCompleteness] = useState({ total: 0, personal_info: 0, education: 0, skills: 0, experience: 0, achievements: 0, canBuild: false });
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved
  const [buildState, setBuildState] = useState('idle'); // idle | processing | done | failed
  const [error, setError] = useState('');
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState(null);
  const [photoState, setPhotoState] = useState('idle'); // idle | uploading | done | failed
  // Last 5 builds — every build is a permanent, separate S3 object + documents
  // row (nothing is ever overwritten), so this survives the student clearing
  // their laptop entirely. Refetched after every successful build so a new
  // build appears at the top immediately.
  const [history, setHistory] = useState([]);
  // Which text box is currently being AI-enhanced (null = none). One at a
  // time is deliberate — parallel enhance calls on a shared no-limit endpoint
  // is exactly the Stupid Path (rapid double-click) we test for.
  const [enhancingField, setEnhancingField] = useState(null);

  // Generic per-field AI Enhance: read current value via getter, replace via
  // setter. The autosave effect picks up the change and persists it like any
  // hand-typed edit.
  const handleEnhance = async (fieldKey, getValue, setValue) => {
    if (enhancingField) return; // one at a time
    const current = (getValue() || '').trim();
    if (current.length < 10) {
      setError('Write a few words first — then AI Enhance can improve them.');
      return;
    }
    setError('');
    setEnhancingField(fieldKey);
    try {
      const { enhanced } = await enhanceText(current);
      if (enhanced) setValue(enhanced);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not enhance right now — please try again.');
    } finally {
      setEnhancingField(null);
    }
  };

  const saveTimer = useRef(null);
  const pollTimer = useRef(null);
  const skipNextSave = useRef(true); // don't autosave the instant we load the existing draft

  useEffect(() => {
    getDraft()
      .then(({ draft: loaded, completeness: c }) => {
        if (loaded) setDraft(wireToDraft(loaded));
        if (loaded?.personal_info?.photo_key) setPhotoState('done'); // already uploaded in a previous session
        if (c) setCompleteness(c);
      })
      .catch(() => setError('Could not load your saved draft. You can still start filling the form.'))
      .finally(() => setLoading(false));

    // Template list is fetched from the backend (not hardcoded) so the
    // picker always matches the actual whitelist the server will accept.
    getTemplates()
      .then(({ templates: list, defaultTemplateId }) => {
        setTemplates(list || []);
        setSelectedTemplateId(defaultTemplateId || list?.[0]?.id || null);
      })
      .catch(() => {}); // non-critical — Build still works with no template chosen (backend defaults)

    refreshHistory();

    return () => {
      clearTimeout(saveTimer.current);
      clearInterval(pollTimer.current);
    };
  }, []);

  // Debounced autosave — fires 800ms after the student stops typing.
  useEffect(() => {
    if (skipNextSave.current) { skipNextSave.current = false; return; }
    setSaveState('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveDraft(draftToWire(draft))
        .then(({ completeness: c }) => { setCompleteness(c); setSaveState('saved'); })
        .catch(() => setSaveState('idle'));
    }, 800);
    return () => clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const updatePersonal = (field, value) =>
    setDraft((d) => ({ ...d, personal_info: { ...d.personal_info, [field]: value } }));

  // Photo goes client → S3 directly (project rule), never through our API
  // body — only the resulting S3 key is saved into the draft. A local
  // object-URL preview shows immediately, before the upload even finishes.
  const handlePhotoChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      setError('Please upload a JPG or PNG photo.');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError('Photo must be under 4MB.');
      return;
    }
    setError('');
    setPhotoPreviewUrl(URL.createObjectURL(file));
    setPhotoState('uploading');
    try {
      const photoKey = await uploadPhotoToS3(file);
      updatePersonal('photo_key', photoKey);
      setPhotoState('done');
    } catch (err) {
      setPhotoState('failed');
      setError('Photo upload failed — you can still build without a photo, or try again.');
    }
  };

  const updateEducation = (i, field, value) =>
    setDraft((d) => ({ ...d, education: d.education.map((e, idx) => (idx === i ? { ...e, [field]: value } : e)) }));
  const addEducation = () =>
    setDraft((d) => ({ ...d, education: [...d.education, { institution: '', degree: '', year: '', gpa: '', coursework: '', honors: '' }] }));
  const removeEducation = (i) =>
    setDraft((d) => ({ ...d, education: d.education.filter((_, idx) => idx !== i) }));

  const updateExperience = (i, field, value) =>
    setDraft((d) => ({ ...d, experience: d.experience.map((e, idx) => (idx === i ? { ...e, [field]: value } : e)) }));
  const addExperience = () =>
    setDraft((d) => ({ ...d, experience: [...d.experience, { role: '', organization: '', location: '', duration: '', bulletsText: '' }] }));
  const removeExperience = (i) =>
    setDraft((d) => ({ ...d, experience: d.experience.filter((_, idx) => idx !== i) }));

  const updateVolunteer = (i, field, value) =>
    setDraft((d) => ({ ...d, volunteer: d.volunteer.map((e, idx) => (idx === i ? { ...e, [field]: value } : e)) }));
  const addVolunteer = () =>
    setDraft((d) => ({ ...d, volunteer: [...d.volunteer, { role: '', organization: '', location: '', duration: '', bulletsText: '' }] }));
  const removeVolunteer = (i) =>
    setDraft((d) => ({ ...d, volunteer: d.volunteer.filter((_, idx) => idx !== i) }));

  const updateSkill = (key, value) =>
    setDraft((d) => ({ ...d, skills: { ...d.skills, [key]: value } }));

  // Non-critical — a failure here just means the "My Resumes" list doesn't
  // refresh; it never blocks Build/Download, which don't depend on it.
  const refreshHistory = () => {
    getResumeHistory()
      .then(({ history: list }) => setHistory(list || []))
      .catch(() => {});
  };

  const stopPolling = () => { clearInterval(pollTimer.current); pollTimer.current = null; };

  const poll = useCallback((buildId) => {
    stopPolling();
    pollTimer.current = setInterval(() => {
      getBuildResult(buildId)
        .then(({ status }) => {
          if (status === 'done') { setBuildState('done'); stopPolling(); refreshHistory(); }
          else if (status === 'failed') { setBuildState('failed'); stopPolling(); }
        })
        .catch(() => { setBuildState('failed'); stopPolling(); });
    }, 2000);
  }, []);

  const handleBuild = async () => {
    setError('');
    setBuildState('processing');
    try {
      const { buildId } = await buildResume(selectedTemplateId);
      poll(buildId);
    } catch (err) {
      setBuildState('failed');
      const missing = err.response?.data?.missing;
      setError(
        missing?.length
          ? `Please finish: ${missing.map((s) => SECTION_LABELS[s] || s).join(', ')}.`
          : err.response?.data?.error || 'Could not start the build. Please try again.'
      );
    }
  };

  if (loading) return <div style={styles.page}><p style={styles.loadingText}>Loading your resume builder…</p></div>;

  return (
    <div style={styles.page}>
      <style>{css}</style>
      <div style={styles.container}>
        <p style={styles.eyebrow}>Law AI</p>
        <h1 style={styles.title}>Resume Builder</h1>
        <div style={styles.titleRule} />
        <p style={styles.subtitle}>Fill in your details — you can build and rebuild your resume as many times as you like.</p>

        <CompletenessBar completeness={completeness} saveState={saveState} />

        {error && <div style={styles.errorBox}>{error}</div>}

        <SectionCard title="Personal Info" required>
          <div className="rb-grid">
            <Field label="Full name" value={draft.personal_info.full_name} onChange={(v) => updatePersonal('full_name', v)} />
            <Field label="Email" value={draft.personal_info.email} onChange={(v) => updatePersonal('email', v)} />
            <Field label="Phone" value={draft.personal_info.phone} onChange={(v) => updatePersonal('phone', v)} />
            <Field label="Target field / role" value={draft.personal_info.target_field} onChange={(v) => updatePersonal('target_field', v)} placeholder="e.g. Corporate Law · Litigation Associate" />
            <Field label="City, Country" value={draft.personal_info.city_country} onChange={(v) => updatePersonal('city_country', v)} />
            <Field label="LinkedIn" value={draft.personal_info.linkedin} onChange={(v) => updatePersonal('linkedin', v)} />
          </div>
          <div className="rb-photo-row">
            {photoPreviewUrl ? (
              <img src={photoPreviewUrl} alt="Profile preview" className="rb-photo-preview" />
            ) : (
              <div className="rb-photo-placeholder">{photoState === 'done' ? 'Photo saved' : 'No photo'}</div>
            )}
            <div>
              <label className="rb-photo-btn">
                {photoState === 'uploading' ? 'Uploading…' : photoState === 'done' ? 'Replace photo' : 'Upload photo'}
                <input type="file" accept="image/jpeg,image/png" onChange={handlePhotoChange} style={{ display: 'none' }} />
              </label>
              <p style={styles.hint}>Optional — JPG/PNG, under 4MB. Only shown on templates designed for a photo.</p>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Profile Summary">
          <TextArea
            rows={3}
            value={draft.profile_summary}
            onChange={(v) => setDraft((d) => ({ ...d, profile_summary: v }))}
            placeholder="2–3 lines: who you are, your legal focus area, what you're seeking."
            enhancing={enhancingField === 'profile_summary'}
            onEnhance={() => handleEnhance('profile_summary',
              () => draft.profile_summary,
              (v) => setDraft((d) => ({ ...d, profile_summary: v })))}
          />
        </SectionCard>

        <SectionCard title="Education" required>
          {draft.education.map((e, i) => (
            <div key={i} className="rb-entry">
              <div className="rb-grid">
                <Field label="Institution" value={e.institution} onChange={(v) => updateEducation(i, 'institution', v)} />
                <Field label="Degree" value={e.degree} onChange={(v) => updateEducation(i, 'degree', v)} />
                <Field label="Year(s)" value={e.year} onChange={(v) => updateEducation(i, 'year', v)} placeholder="2022 - 2027" />
                <Field label="GPA / Class / Rank" value={e.gpa} onChange={(v) => updateEducation(i, 'gpa', v)} />
              </div>
              <Field label="Relevant coursework" value={e.coursework} onChange={(v) => updateEducation(i, 'coursework', v)} />
              <Field label="Honors / scholarships" value={e.honors} onChange={(v) => updateEducation(i, 'honors', v)} />
              {draft.education.length > 1 && <button type="button" className="rb-remove" onClick={() => removeEducation(i)}>Remove this entry</button>}
            </div>
          ))}
          <button type="button" className="rb-add" onClick={addEducation}>+ Add another education entry</button>
        </SectionCard>

        <SectionCard title="Skills" required subtitle="At least 3 skills total, across any of the categories below.">
          <div className="rb-grid">
            {Object.entries(SKILL_LABELS).map(([key, label]) => (
              <Field key={key} label={`${label} (comma-separated)`} value={draft.skills[key]} onChange={(v) => updateSkill(key, v)} />
            ))}
          </div>
        </SectionCard>

        <SectionCard
          title="Experience & Internships"
          bonus
          subtitle="Be specific: name the exact law/regulation you worked on (SEBI, Companies Act, GDPR…) and add numbers where true (drafted 12 memos, reviewed 30+ contracts)."
        >
          {draft.experience.map((e, i) => (
            <div key={i} className="rb-entry">
              <div className="rb-grid">
                <Field label="Role" value={e.role} onChange={(v) => updateExperience(i, 'role', v)} placeholder="e.g. Legal Intern" />
                <Field label="Organization" value={e.organization} onChange={(v) => updateExperience(i, 'organization', v)} />
                <Field label="Location" value={e.location} onChange={(v) => updateExperience(i, 'location', v)} />
                <Field label="Duration" value={e.duration} onChange={(v) => updateExperience(i, 'duration', v)} placeholder="May 2025 - Jul 2025" />
              </div>
              <TextArea
                rows={3}
                label="What did you do? (one line per bullet)"
                value={e.bulletsText}
                onChange={(v) => updateExperience(i, 'bulletsText', v)}
                placeholder={'Drafted internal legal memos on SEBI LODR compliance\nAssisted on due diligence for 3 M&A transactions under the Companies Act, 2013'}
                enhancing={enhancingField === `experience_${i}`}
                onEnhance={() => handleEnhance(`experience_${i}`,
                  () => draft.experience[i]?.bulletsText,
                  (v) => updateExperience(i, 'bulletsText', v))}
              />
              <button type="button" className="rb-remove" onClick={() => removeExperience(i)}>Remove this entry</button>
            </div>
          ))}
          <button type="button" className="rb-add" onClick={addExperience}>+ Add experience / internship</button>
          {draft.experience.length === 1 && (
            <p style={styles.hint}>
              Tip: a single entry can leave your resume looking sparse. A second internship, research
              assistantship, or even law-firm shadowing counts — add it if you have one.
            </p>
          )}
        </SectionCard>

        <SectionCard
          title="Volunteer & Pro Bono"
          bonus
          subtitle="Legal aid clinics, NGO work, community drives — quantify it where true (served 50+ clients, led team of 8 volunteers)."
        >
          {draft.volunteer.map((e, i) => (
            <div key={i} className="rb-entry">
              <div className="rb-grid">
                <Field label="Role" value={e.role} onChange={(v) => updateVolunteer(i, 'role', v)} placeholder="e.g. Volunteer Coordinator" />
                <Field label="Organization" value={e.organization} onChange={(v) => updateVolunteer(i, 'organization', v)} placeholder="e.g. Campus Legal Aid Clinic" />
                <Field label="Location" value={e.location} onChange={(v) => updateVolunteer(i, 'location', v)} />
                <Field label="Duration" value={e.duration} onChange={(v) => updateVolunteer(i, 'duration', v)} placeholder="Aug 2024 - Present" />
              </div>
              <TextArea
                rows={2}
                label="What did you do? (one line per bullet)"
                value={e.bulletsText}
                onChange={(v) => updateVolunteer(i, 'bulletsText', v)}
                placeholder={'Coordinated legal aid clinic serving 50+ clients per semester\nLed a team of 8 volunteers running legal literacy camps'}
                enhancing={enhancingField === `volunteer_${i}`}
                onEnhance={() => handleEnhance(`volunteer_${i}`,
                  () => draft.volunteer[i]?.bulletsText,
                  (v) => updateVolunteer(i, 'bulletsText', v))}
              />
              <button type="button" className="rb-remove" onClick={() => removeVolunteer(i)}>Remove this entry</button>
            </div>
          ))}
          <button type="button" className="rb-add" onClick={addVolunteer}>+ Add volunteer / pro bono work</button>
        </SectionCard>

        <SectionCard
          title="Achievements & Activities"
          bonus
          subtitle="One per line. For moot courts, include the level and your role — only if true: national/international, Best Speaker, argued respondent side."
        >
          <TextArea
            rows={3}
            value={draft.achievements}
            onChange={(v) => setDraft((d) => ({ ...d, achievements: v }))}
            placeholder={'Semi-finalist, 12th NLU National Moot Court Competition — argued respondent side\nBest Speaker, intra-college moot on constitutional law'}
            enhancing={enhancingField === 'achievements'}
            onEnhance={() => handleEnhance('achievements',
              () => draft.achievements,
              (v) => setDraft((d) => ({ ...d, achievements: v })))}
          />
        </SectionCard>

        <SectionCard title="Certifications & Courses" subtitle="Optional. One per line — legal research, negotiation, Coursera/SCC Online certifications all count.">
          <TextArea
            rows={2}
            value={draft.certifications}
            onChange={(v) => setDraft((d) => ({ ...d, certifications: v }))}
            placeholder={'SCC Online Certificate in Legal Research (2025)\nContract Law: From Trust to Promise — HarvardX (Coursera, 2024)'}
          />
        </SectionCard>

        <SectionCard title="Bar Admissions" subtitle="Optional. One per line.">
          <TextArea rows={2} value={draft.bar_admissions} onChange={(v) => setDraft((d) => ({ ...d, bar_admissions: v }))} />
        </SectionCard>

        <SectionCard title="Languages" subtitle="Optional. Comma-separated, with fluency — useful for litigation and cross-border work.">
          <Field value={draft.languages} onChange={(v) => setDraft((d) => ({ ...d, languages: v }))} placeholder="English (Fluent), Hindi (Native), Marathi (Native)" />
        </SectionCard>

        {templates.length > 0 && (
          <SectionCard title="Choose a Template" subtitle="Pick a look for your resume — you can rebuild with a different template anytime without re-entering your details.">
            <div className="rb-template-grid">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`rb-template-card${selectedTemplateId === t.id ? ' rb-template-card--selected' : ''}`}
                  onClick={() => setSelectedTemplateId(t.id)}
                >
                  <span className="rb-template-swatch" style={{ background: TEMPLATE_SWATCHES[t.id] || '#555' }} />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </SectionCard>
        )}

        <div style={styles.buildBar}>
          <button
            type="button"
            className="rb-build-btn"
            disabled={!completeness.canBuild || buildState === 'processing'}
            onClick={handleBuild}
          >
            {buildState === 'processing' ? 'Building…' : 'Build Resume'}
          </button>
          {!completeness.canBuild && <span style={styles.hint}>Complete Personal Info, Education, and Skills to unlock Build.</span>}
          {buildState === 'failed' && <span style={styles.errorInline}>Build failed — please try again.</span>}
        </div>

        {history.length > 0 && (
          <SectionCard title="My Resumes" subtitle="Your last 5 builds — always available here, even if you've deleted the file from your device.">
            <ul className="rb-history-list">
              {history.map((h) => (
                <li key={h.buildId} className="rb-history-row">
                  <span className="rb-history-meta">
                    <span className="rb-history-template">{h.templateLabel}</span>
                    <span className="rb-history-date">{new Date(h.createdAt).toLocaleString()}</span>
                  </span>
                  <a href={h.downloadUrl} target="_blank" rel="noreferrer" className="rb-history-download">Download</a>
                </li>
              ))}
            </ul>
          </SectionCard>
        )}

      </div>
    </div>
  );
}

// ── Small presentational pieces ────────────────────────────────────────────
const SectionCard = ({ title, required, bonus, subtitle, children }) => (
  <section style={styles.card}>
    <div style={styles.cardHeaderRow}>
      <h2 style={styles.cardTitle}>{title}</h2>
      {required && <span style={styles.tagRequired}>Required</span>}
      {bonus && <span style={styles.tagBonus}>Bonus</span>}
    </div>
    {subtitle && <p style={styles.cardSubtitle}>{subtitle}</p>}
    {children}
  </section>
);

const Field = ({ label, value, onChange, placeholder }) => (
  <label style={styles.fieldLabel}>
    {label}
    <input className="rb-input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  </label>
);

const TextArea = ({ label, rows = 3, value, onChange, placeholder, onEnhance, enhancing }) => (
  <label style={styles.fieldLabel}>
    {label}
    <textarea className="rb-input" rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    {onEnhance && (
      <button
        type="button"
        className="rb-enhance-btn"
        disabled={enhancing}
        onClick={(e) => { e.preventDefault(); onEnhance(); }}
      >
        {enhancing ? 'Enhancing…' : '✦ AI Enhance'}
      </button>
    )}
  </label>
);

const CompletenessBar = ({ completeness, saveState }) => (
  <div style={styles.completenessWrap}>
    <div style={styles.completenessTopRow}>
      <span style={styles.completenessPct}>{completeness.total}% complete</span>
      <span style={styles.saveIndicator}>{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : ''}</span>
    </div>
    <div style={styles.progressTrack}>
      <div style={{ ...styles.progressFill, width: `${completeness.total}%` }} />
    </div>
    <div className="rb-chip-row">
      {Object.entries(SECTION_LABELS).map(([key, label]) => (
        <span key={key} style={styles.chip}>{label}: {completeness[key]}%</span>
      ))}
    </div>
  </div>
);

// ── Theme tokens ──────────────────────────────────────────────────────────
// Near-black warm background, parchment-grey text (never pure white), a
// single brass accent spent only on primary actions + AI features + focus
// states + selection. Two serif roles: Playfair Display (display/headings)
// and Source Serif 4 (body/labels/inputs) — both genuinely serif per brief,
// not a sans-serif body dressed up with a serif h1.
const INK = '#F8F5EB';        // primary text — warm off-white
const INK_DIM = '#B8AF94';    // secondary text (subtitles, captions)
const INK_FAINT = '#8B8880';  // tertiary text (hints, placeholders, disabled)
const BG = '#090A0F';         // page background — deep luxury black
const SURFACE = 'rgba(18, 19, 26, 0.85)'; // card fill
const HAIRLINE = 'rgba(212, 175, 55, 0.25)'; // gold hairline borders
const ACCENT = '#D4AF37';     // metallic gold
const ACCENT_DIM = 'rgba(212, 175, 55, 0.18)';
const DISPLAY_FONT = "'Playfair Display', Georgia, 'Times New Roman', serif";
const BODY_FONT = "'Source Serif 4', Georgia, 'Times New Roman', serif";

const styles = {
  page: { minHeight: '100vh', width: '100%', background: BG, fontFamily: BODY_FONT, padding: '1.25rem', boxSizing: 'border-box' },
  container: { maxWidth: '860px', margin: '0 auto' },
  loadingText: { color: INK_DIM, textAlign: 'center', marginTop: '3rem', fontStyle: 'italic' },
  eyebrow: { color: ACCENT, fontFamily: BODY_FONT, fontSize: '0.72rem', letterSpacing: '0.24em', textTransform: 'uppercase', margin: '0 0 0.35rem' },
  title: { color: INK, fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: 'clamp(1.7rem, 4vw, 2.3rem)', margin: 0, letterSpacing: '0.01em' },
  titleRule: { width: '46px', height: '2px', background: ACCENT, margin: '0.85rem 0 0.9rem', border: 'none' },
  subtitle: { color: INK_DIM, fontSize: '0.92rem', fontStyle: 'italic', marginTop: 0, marginBottom: '1.75rem' },
  card: { background: SURFACE, border: `1px solid ${HAIRLINE}`, borderRadius: '4px', padding: '1.35rem', marginBottom: '1rem' },
  cardHeaderRow: { display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' },
  cardTitle: { color: INK, fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: '1.15rem', margin: 0, letterSpacing: '0.01em' },
  cardSubtitle: { color: INK_DIM, fontSize: '0.82rem', fontStyle: 'italic', margin: '0.3rem 0 0.9rem' },
  tagRequired: { fontSize: '0.65rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: BG, background: ACCENT, padding: '0.18rem 0.55rem', borderRadius: '2px' },
  tagBonus: { fontSize: '0.65rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: INK_DIM, background: 'transparent', border: `1px solid ${HAIRLINE}`, padding: '0.15rem 0.5rem', borderRadius: '2px' },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: '0.35rem', color: INK_DIM, fontSize: '0.8rem', marginBottom: '0.9rem' },
  completenessWrap: { marginBottom: '1.5rem' },
  completenessTopRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' },
  completenessPct: { color: INK, fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: '1.05rem' },
  saveIndicator: { color: INK_FAINT, fontSize: '0.75rem', fontStyle: 'italic' },
  progressTrack: { width: '100%', height: '3px', background: HAIRLINE, borderRadius: '0', overflow: 'hidden' },
  progressFill: { height: '100%', background: ACCENT, borderRadius: '0', transition: 'width 0.3s ease' },
  chip: { fontSize: '0.7rem', color: INK_DIM, background: 'transparent', border: `1px solid ${HAIRLINE}`, padding: '0.2rem 0.55rem', borderRadius: '2px' },
  buildBar: { display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginTop: '1.5rem', paddingBottom: '2rem' },
  hint: { color: INK_FAINT, fontSize: '0.8rem', fontStyle: 'italic' },
  errorBox: { background: 'rgba(214,90,90,0.12)', border: '1px solid rgba(214,90,90,0.4)', color: '#E3A5A5', borderRadius: '4px', padding: '0.7rem 1rem', fontSize: '0.85rem', marginBottom: '1rem' },
  errorInline: { color: '#E3A5A5', fontSize: '0.85rem' },
};

// Real CSS for things inline style objects can't do: :focus/:hover states,
// the auto-responsive field grid, small-screen spacing, and the two Google
// Fonts (Playfair Display for headings, Source Serif 4 for body/inputs —
// both genuinely serif). @import is safe here since this renders in a real
// browser at runtime, not a sandboxed preview.
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700&family=Source+Serif+4:ital,wght@0,400;0,600;1,400&display=swap');

  .rb-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0 1rem; }
  .rb-input {
    background: rgba(255,255,255,0.03); border: 1px solid ${HAIRLINE}; border-radius: 3px;
    padding: 0.6rem 0.75rem; color: ${INK}; font-size: 0.95rem; font-family: ${BODY_FONT}; outline: none;
    transition: border-color 0.15s ease, background 0.15s ease; resize: vertical; width: 100%; box-sizing: border-box;
  }
  .rb-input:focus { border-color: ${ACCENT}; background: rgba(176,141,87,0.05); }
  .rb-input::placeholder { color: ${INK_FAINT}; font-style: italic; }
  .rb-entry { border-top: 1px dashed ${HAIRLINE}; padding-top: 0.9rem; margin-top: 0.9rem; }
  .rb-entry:first-child { border-top: none; padding-top: 0; margin-top: 0; }
  .rb-add, .rb-remove {
    background: transparent; border: 1px solid ${HAIRLINE}; color: ${INK_DIM};
    border-radius: 3px; padding: 0.45rem 0.9rem; font-size: 0.8rem; cursor: pointer; font-family: ${BODY_FONT};
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }
  .rb-add:hover { background: ${ACCENT_DIM}; border-color: ${ACCENT}; color: ${INK}; }
  .rb-remove:hover { background: rgba(214,90,90,0.1); border-color: rgba(214,90,90,0.5); }
  .rb-remove { color: #C98080; border-color: rgba(214,90,90,0.25); margin-top: 0.5rem; }
  .rb-chip-row { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.6rem; }

  .rb-build-btn {
    background: ${ACCENT}; color: ${BG}; border: none; border-radius: 3px; padding: 0.85rem 1.9rem;
    font-size: 0.95rem; font-weight: 600; font-family: ${DISPLAY_FONT}; letter-spacing: 0.03em;
    cursor: pointer; transition: opacity 0.15s ease, transform 0.1s ease;
  }
  .rb-build-btn:disabled { background: ${HAIRLINE}; color: ${INK_FAINT}; cursor: not-allowed; }
  .rb-build-btn:not(:disabled):hover { opacity: 0.88; }
  .rb-build-btn:not(:disabled):active { transform: scale(0.98); }

  .rb-enhance-btn {
    align-self: flex-start; margin-top: 0.35rem;
    background: transparent; border: 1px solid rgba(176,141,87,0.4); color: ${ACCENT};
    border-radius: 3px; padding: 0.35rem 0.85rem; font-size: 0.74rem; letter-spacing: 0.04em; cursor: pointer; font-family: ${BODY_FONT}; font-style: italic;
    transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
  }
  .rb-enhance-btn:hover:not(:disabled) { background: ${ACCENT_DIM}; border-color: ${ACCENT}; }
  .rb-enhance-btn:disabled { opacity: 0.5; cursor: wait; }

  .rb-photo-row { display: flex; align-items: center; gap: 1rem; margin-top: 0.9rem; padding-top: 0.9rem; border-top: 1px dashed ${HAIRLINE}; flex-wrap: wrap; }
  .rb-photo-preview { width: 64px; height: 64px; border-radius: 50%; object-fit: cover; border: 1px solid ${HAIRLINE}; }
  .rb-photo-placeholder {
    width: 64px; height: 64px; border-radius: 50%; border: 1px dashed ${HAIRLINE};
    display: flex; align-items: center; justify-content: center; text-align: center;
    color: ${INK_FAINT}; font-size: 0.63rem; font-style: italic; padding: 0.3rem; box-sizing: border-box;
  }
  .rb-photo-btn {
    display: inline-block; background: transparent; border: 1px solid ${HAIRLINE}; color: ${INK_DIM};
    border-radius: 3px; padding: 0.5rem 1rem; font-size: 0.8rem; cursor: pointer; font-family: ${BODY_FONT};
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }
  .rb-photo-btn:hover { background: ${ACCENT_DIM}; border-color: ${ACCENT}; color: ${INK}; }

  .rb-template-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.6rem; }
  .rb-template-card {
    display: flex; flex-direction: column; align-items: center; gap: 0.5rem;
    background: ${SURFACE}; border: 1px solid ${HAIRLINE}; border-radius: 3px;
    padding: 0.9rem 0.5rem; cursor: pointer; font-family: ${BODY_FONT}; font-size: 0.78rem; color: ${INK_DIM};
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .rb-template-card:hover { background: ${ACCENT_DIM}; border-color: rgba(176,141,87,0.5); }
  .rb-template-card--selected { border-color: ${ACCENT}; background: ${ACCENT_DIM}; color: ${INK}; font-weight: 600; }
  .rb-template-swatch { width: 32px; height: 32px; border-radius: 2px; border: 1px solid ${HAIRLINE}; }

  .rb-history-list { list-style: none; margin: 0; padding: 0; }
  .rb-history-row {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding: 0.65rem 0; border-top: 1px dashed ${HAIRLINE}; flex-wrap: wrap;
  }
  .rb-history-row:first-child { border-top: none; }
  .rb-history-meta { display: flex; flex-direction: column; gap: 0.15rem; }
  .rb-history-template { color: ${INK}; font-size: 0.88rem; font-weight: 600; }
  .rb-history-date { color: ${INK_FAINT}; font-size: 0.72rem; font-style: italic; }
  .rb-history-download {
    background: transparent; border: 1px solid ${ACCENT}; color: ${ACCENT}; text-decoration: none;
    border-radius: 3px; padding: 0.4rem 0.9rem; font-size: 0.8rem; font-weight: 600; font-family: ${BODY_FONT};
    transition: background 0.15s ease;
  }
  .rb-history-download:hover { background: ${ACCENT_DIM}; }

  /* Small phones (iOS/Android narrow widths) — tighter padding, full-width form fields */
  @media (max-width: 480px) {
    .rb-grid { grid-template-columns: 1fr; }
    .rb-template-grid { grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); }
    .rb-history-row { flex-direction: column; align-items: flex-start; }
  }
`;
