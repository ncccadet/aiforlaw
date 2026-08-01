/**
 * resumeTemplates.js — shared template whitelist for the Resume Builder feature.
 *
 * Pure data, no side effects — this is what makes it safe to require from
 * BOTH resumeBuilder.controller.js (for validating an incoming template_id
 * and listing options to the frontend) AND resumeBuilder.worker.js (which
 * pairs each id with its actual pdfkit render function). The controller
 * must NEVER `require('../workers/resumeBuilder.worker.js')` directly —
 * that file starts a live BullMQ Worker as a side effect of being loaded,
 * which would run job-processing code inside the API process instead of
 * the separate worker process it belongs in.
 */
const TEMPLATE_LABELS = {
  law_resume_v1: 'Classic Maroon',
  charcoal_modern: 'Charcoal Modern',
  monochrome_minimal: 'Monochrome Minimal',
  emerald_classic: 'Emerald Classic',
  bold_banner: 'Bold Banner',
  navy_sidebar: 'Navy Sidebar',
  // Photo-enabled templates, added per founder request to match reference
  // designs with a profile photo. Every template (old and new) now renders
  // the student's photo if one was uploaded — see photo_key handling in
  // resumeBuilder.worker.js — these three are additionally laid out
  // specifically around having a photo as a visual anchor.
  executive_boxed: 'Executive Boxed',
  olive_sidebar: 'Olive Sidebar',
  charcoal_split: 'Charcoal Split',
  // Reference-design recreations (founder request, 2026-07-21) — layouts
  // matched to three approved reference resumes; no third-party branding,
  // no fake skill-proficiency meters.
  boxed_monochrome: 'Boxed Monochrome',
  olive_pro: 'Olive Professional',
  slate_chevron: 'Slate Chevron',
};
const TEMPLATE_IDS = Object.keys(TEMPLATE_LABELS);
const DEFAULT_TEMPLATE_ID = 'law_resume_v1';

module.exports = { TEMPLATE_IDS, TEMPLATE_LABELS, DEFAULT_TEMPLATE_ID };
