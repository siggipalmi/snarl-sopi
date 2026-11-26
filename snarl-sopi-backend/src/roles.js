/**
 * User roles and what each may do (Siggi, 2026-10-22). One table, used by the route guards, the
 * dashboard's invite and edit screens (GET /api/v1/roles) and the role emails, so the description a
 * user reads is the rule the backend enforces.
 *
 *   ag_admin           AG Vending: everything.
 *   operator_admin     Everything for their own operator.
 *   operator_manager   Runs the operator's machines; no users, invoices or refunds.
 *   operator_restocker Opens, restocks and moves products on their ASSIGNED machines only.
 *
 * operator_viewer was meant to be read-only but was never enforced. Accounts that still have it are
 * treated as restockers (normalizeRole); the stored value is left alone.
 */

// What a non-AG role may do. 'restock' is the floor every signed-in user has.
const CAPS = {
  operator_admin:     ['restock', 'prices', 'sales', 'manage', 'close', 'complaints', 'refunds', 'products', 'users', 'billing'],
  operator_manager:   ['restock', 'prices', 'sales', 'manage', 'close', 'complaints', 'products'],
  operator_restocker: ['restock'],
};

// "Your role (Restocker) can't <text>."
const CAP_TEXT = {
  restock: 'restock', prices: 'change prices', sales: 'see sales figures',
  manage: 'change machine settings', close: 'close or reopen a machine',
  complaints: 'handle complaints', refunds: 'issue refunds', products: 'edit existing catalog products',
  users: 'manage users', billing: 'see invoices',
};

// Shown in the dashboard and the emails. Order = most to least access.
const ROLES = [
  { id: 'ag_admin', agOnly: true, label: 'AG Vending admin', labelIs: 'AG Vending stjórnandi',
    description: 'Everything, for every operator.',
    descriptionIs: 'Allur aðgangur, fyrir alla rekstraraðila.' },
  { id: 'operator_admin', label: 'Operator admin', labelIs: 'Rekstrarstjóri',
    description: 'Everything for your company: users, invoices, refunds, prices, machines.',
    descriptionIs: 'Allt fyrir fyrirtækið: notendur, reikningar, endurgreiðslur, verð og vélar.' },
  { id: 'operator_manager', label: 'Manager', labelIs: 'Umsjónarmaður',
    description: 'Runs the machines: prices, planogram, sales, closing a machine, replying to complaints.',
    descriptionIs: 'Sér um vélarnar: verð, vöruuppröðun, sölu, lokun vélar og svör við kvörtunum.' },
  { id: 'operator_restocker', label: 'Restocker', labelIs: 'Áfyllingaraðili', needsMachines: true,
    description: 'Opens doors, restocks and moves products, on the machines chosen for them. No prices or sales figures.',
    descriptionIs: 'Opnar hurðir, fyllir á og færir vörur, á þeim vélum sem valdar eru. Sér ekki verð né sölutölur.' },
];
const ROLE_IDS = ROLES.map(r => r.id);

// The same roles as an operator of parcel lockers reads them (Siggi, 2026-11-26). The rules are
// the same table above; only the words differ, since a locker has nothing to restock or price.
const LOCKER_TEXT = {
  operator_admin: {
    description: 'Everything for your company: users, the SMS texts, the web shop connection, and the lockers.',
    descriptionIs: 'Allt fyrir fyrirtækið: notendur, SMS-textar, tenging við vefverslun og skáparnir.' },
  operator_manager: {
    description: 'Runs the lockers: boxes, orders and the details customers are told. No SMS texts, web shop or users.',
    descriptionIs: 'Sér um skápana: hólf, pantanir og upplýsingar til viðskiptavina. Ekki SMS-textar, vefverslun né notendur.' },
  operator_restocker: {
    label: 'Staff', labelIs: 'Starfsmaður',
    description: 'The day\'s work on the lockers chosen for them: see the boxes, add an order, open a box, mark a parcel picked up. Changes no settings.',
    descriptionIs: 'Dagleg verk á þeim skápum sem valdir eru: sjá hólfin, bæta við pöntun, opna hólf og merkja sendingu sótta. Breytir engum stillingum.' },
};

function normalizeRole(role) {
  return role === 'operator_viewer' ? 'operator_restocker' : role;
}

function can(user, cap) {
  if (!user) return false;
  if (user.role === 'ag_admin') return true;
  return (CAPS[normalizeRole(user.role)] || []).includes(cap);
}

function roleInfo(role, locker) {
  const r = ROLES.find(x => x.id === normalizeRole(role)) || null;
  return r && locker && LOCKER_TEXT[r.id] ? { ...r, ...LOCKER_TEXT[r.id] } : r;
}

/** What changes going from one role to another, for the edit screen: { gains, loses } as CAP_TEXT. */
function roleChange(fromRole, toRole) {
  const caps = r => (normalizeRole(r) === 'ag_admin' ? Object.keys(CAP_TEXT) : (CAPS[normalizeRole(r)] || []));
  const a = new Set(caps(fromRole)), b = new Set(caps(toRole));
  return { gains: [...b].filter(c => !a.has(c)).map(c => CAP_TEXT[c]),
           loses: [...a].filter(c => !b.has(c)).map(c => CAP_TEXT[c]) };
}

/** Roles [user] may give to someone: AG any; an operator admin anything but AG admin; others none. */
function grantableRoles(user) {
  if (!user) return [];
  if (user.role === 'ag_admin') return ROLE_IDS.slice();
  if (normalizeRole(user.role) === 'operator_admin') return ROLE_IDS.filter(r => r !== 'ag_admin');
  return [];
}

module.exports = { CAPS, CAP_TEXT, ROLES, ROLE_IDS, LOCKER_TEXT, normalizeRole, can, roleInfo, roleChange, grantableRoles };
