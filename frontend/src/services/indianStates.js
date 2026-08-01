/**
 * indianStates.js (frontend) — the state list the Job Board's Location
 * dropdown is built from.
 *
 * Only the NAMES live here. The city-to-state mapping that actually does the
 * matching lives on the server (backend/utils/indianStates.js), because that
 * is where the listing text is, and duplicating a few hundred city names into
 * the bundle would mean two lists drifting apart. The browser sends a state
 * name; the server decides what counts as being in that state.
 *
 * Order must match the server list so the two stay obviously in sync when
 * either is edited.
 */
export const INDIAN_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  'Andaman & Nicobar Islands',
  'Chandigarh',
  'Dadra & Nagar Haveli and Daman & Diu',
  'Delhi',
  'Jammu & Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
];
