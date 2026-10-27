const pages = [
  { name: "الرئيسية", icon: "⌂" },
  { name: "الصيدليات", icon: "▦" },
  { name: "المبيعات", icon: "↗", type: "sale" },
  { name: "المشتريات", icon: "↙", type: "purchase" },
  { name: "النفقات", icon: "◷", type: "expense" },
  { name: "الإيرادات", icon: "♙", type: "income" },
  { name: "التوريدات", icon: "↓", type: "supply" },
  { name: "التسويات", icon: "⇄", type: "adjustment" },
  { name: "التقارير", icon: "▥" },
  { name: "الشيفتات", icon: "▥" },
  { name: "المستخدمون", icon: "♙", admin: true },
];

const transactionTypes = {
  sale: "مبيعات",
  purchase: "مشتريات",
  expense: "نفقات",
  income: "إيرادات",
  supply: "توريد",
  adjustment: "تسوية",
};
const permissionLabels = {
  view_data: "عرض البيانات",
  record_transactions: "تسجيل الحركات",
  close_shifts: "إغلاق الشيفتات",
  manage_shifts: "إدارة الشيفتات",
  delete_transactions: "حذف الحركات",
};
const paymentMethods = [
  { value: "cash", label: "نقدي" },
  { value: "visa", label: "فيزا" },
  { value: "instapay", label: "إنستاباي" },
  { value: "vodafon", label: "فودافون (د/أحمد)" },
  { value: "pharmacy", label: "فودافون (صيدلية)" },
];
const supplyPaymentMethods = paymentMethods.filter(({ value }) => value !== "cash");
const paymentMethodLabels = Object.fromEntries([
  ...paymentMethods.map(({ value, label }) => [value, label]),
  ["bank", "تحويل بنكي"],
  ["credit", "آجل"],
]);
const transactionPages = new Set(["المبيعات", "المشتريات", "النفقات", "الإيرادات", "التوريدات", "التسويات"]);
const mobilePages = [
  { name: "المزيد", icon: "☰", more: true },
  { name: "التقارير", icon: "▥" },
  { name: "الشيفتات", icon: "▥" },
  { name: "النفقات", icon: "◷" },
  { name: "الرئيسية", icon: "▦" },
];
let currentPage = "الرئيسية";
let currentUser = null;
let authState = null;
let pharmacies = [];
let transactions = [];
let users = [];
let shifts = [];
let saleShiftOptions = [];
let saleFormValues = {};
let shiftAnalytics = null;
let summary = {};
let loading = false;
let errorMessage = "";
let authError = "";
const filterValuesByPage = {};
let editingShiftId = null;
let closingShiftId = null;
let editingUserId = null;

const shell = document.querySelector(".app-shell");
const navigation = document.querySelector("#navigation");
const mobileNavigation = document.querySelector("#mobile-navigation");
const mobileMenu = document.querySelector("#mobile-menu");
const accountArea = document.querySelector("#account-area");
const content = document.querySelector("#page-content");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function money(value) {
  return `${new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 2 }).format(Number(value) || 0)} ج.م`;
}

function canManage() {
  return currentUser?.role === "admin";
}

function hasPermission(permission) {
  return canManage() || currentUser?.permissions?.includes(permission) === true;
}

function canManageShifts() {
  return hasPermission("manage_shifts");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "تعذر إكمال الطلب");
  return result;
}

async function loadData() {
  loading = true;
  errorMessage = "";
  try {
    authState = await api("/api/auth/status");
    currentUser = authState.user;
    if (!currentUser) {
      pharmacies = [];
      transactions = [];
      users = [];
      shifts = [];
      shiftAnalytics = null;
      summary = {};
      loading = false;
      render();
      return;
    }
    if (!hasPermission("view_data")) {
      pharmacies = [];
      transactions = [];
      users = [];
      shifts = [];
      shiftAnalytics = null;
      summary = {};
      loading = false;
      render();
      return;
    }
    if (currentPage === "المستخدمون" && !canManage()) currentPage = "الرئيسية";
    if (currentPage === "الشيفتات") {
      shifts = [];
      users = [];
      shiftAnalytics = null;
    }
    render();
    const requests = [
      api("/api/pharmacies"),
      api("/api/dashboard"),
      api(`/api/transactions?${transactionQuery(currentPage)}`),
    ];
    if (currentPage === "المبيعات") {
      const saleForm = document.querySelector("#transaction-form");
      const isSaleForm = saleForm?.querySelector('[name="type"]')?.value === "sale";
      if (isSaleForm) {
        saleFormValues = {
          pharmacyId: saleForm.querySelector('[name="pharmacyId"]').value,
          date: saleForm.querySelector('[name="date"]').value,
          shiftTemplateId: saleForm.querySelector('[name="shiftTemplateId"]')?.value || "",
        };
      }
      const pharmacyId = isSaleForm
        ? saleFormValues.pharmacyId
        : canManage() ? "" : currentUser.pharmacyId;
      saleShiftOptions = pharmacyId
        ? pharmacies.find((pharmacy) => String(pharmacy.id) === String(pharmacyId))?.shifts || []
        : [];
    } else {
      saleShiftOptions = [];
    }
    const shiftsIndex = currentPage === "الشيفتات" ? requests.push(api("/api/shifts")) - 1 : -1;
    const shiftAnalyticsIndex = currentPage === "الشيفتات" ? requests.push(api("/api/shift-analytics")) - 1 : -1;
    const usersIndex = currentPage === "المستخدمون" && canManage()
      ? requests.push(api("/api/users")) - 1
      : currentPage === "الشيفتات" && canManageShifts()
        ? requests.push(api(canManage() ? "/api/users" : "/api/branch-users")) - 1
        : -1;
    const results = await Promise.all(requests);
    [pharmacies, summary, transactions] = results;
    if (shiftsIndex >= 0) shifts = results[shiftsIndex];
    if (shiftAnalyticsIndex >= 0) shiftAnalytics = results[shiftAnalyticsIndex];
    if (usersIndex >= 0) users = results[usersIndex];
    if (currentPage === "المبيعات") {
      saleShiftOptions = saleFormValues.pharmacyId
        ? pharmacies.find((pharmacy) => String(pharmacy.id) === String(saleFormValues.pharmacyId))?.shifts || []
        : [];
      if (!saleShiftOptions.some((shift) => String(shift.id) === String(saleFormValues.shiftTemplateId))) {
        saleFormValues.shiftTemplateId = "";
      }
    }
  } catch (error) {
    if (/يلزم تسجيل الدخول/.test(error.message)) {
      currentUser = null;
      authState = { setupRequired: false, user: null };
    }
    errorMessage = error.message;
  } finally {
    loading = false;
    render();
  }
}

function typeForPage(pageName) {
  const page = pages.find((item) => item.name === pageName);
  return page?.type || "";
}

function transactionQuery(pageName, values = filterValuesByPage[pageName] || {}) {
  const query = new URLSearchParams();
  const type = typeForPage(pageName);
  const pharmacyId = canManage() ? values.pharmacyId : currentUser?.pharmacyId;
  if (type) query.set("type", type);
  if (pharmacyId) query.set("pharmacyId", pharmacyId);
  if (values.from) query.set("from", values.from);
  if (values.to) query.set("to", values.to);
  if (values.paymentMethod) query.set("paymentMethod", values.paymentMethod);
  return query.toString();
}

function table(headers, rows) {
  if (!rows.length) return `<div class="empty-state"><div><span>▤</span>لا توجد بيانات بعد. أضف سجلاً جديداً للبدء.</div></div>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function section(title, body, link = "") {
  return `<section class="section-card"><div class="section-head"><h2>${escapeHtml(title)}</h2>${link}</div>${body}</section>`;
}

function pageLinksMarkup(links) {
  return links.map((page) => `<a href="#" class="${page.name === currentPage ? "active" : "nav-link"}" data-page="${escapeHtml(page.name)}"><span class="nav-icon">${page.icon}</span><span>${escapeHtml(page.name)}</span></a>`).join("");
}

function navMarkup() {
  const visiblePages = pages.filter((page) => (!page.admin || canManage()) && (page.name === "المستخدمون" || hasPermission("view_data")));
  return pageLinksMarkup(visiblePages);
}

function mobileNavMarkup() {
  if (!hasPermission("view_data")) return "";
  const activePageIsHidden = !mobilePages.some((page) => !page.more && page.name === currentPage);
  return mobilePages.map((page) => {
    if (page.more) return `<button class="more-button ${activePageIsHidden ? "active" : ""}" data-action="toggle-menu" aria-expanded="false"><span>${page.icon}</span><span>المزيد</span></button>`;
    return `<a href="#" class="${page.name === currentPage ? "active" : ""}" data-page="${escapeHtml(page.name)}"><span>${page.icon}</span><span>${escapeHtml(page.name)}</span></a>`;
  }).join("");
}

function menuMarkup() {
  const visiblePages = pages.filter((page) => (!page.admin || canManage()) && (page.name === "المستخدمون" || hasPermission("view_data")));
  return `<p class="menu-title">التنقل في النظام</p>${pageLinksMarkup(visiblePages)}<div class="menu-divider"></div><a href="#" data-action="logout"><span>↪</span><span>تسجيل الخروج</span></a>`;
}

function accountMarkup() {
  const role = canManage() ? "مدير النظام" : currentUser?.role === "branch_manager" ? "مدير الفرع" : "مستخدم";
  return `<span class="avatar">${escapeHtml(currentUser?.displayName?.slice(0, 1) || "؟")}</span><span><strong>${escapeHtml(currentUser?.displayName || "")}</strong><small>${role} · ${escapeHtml(currentUser?.username || "")}</small></span><button class="logout" data-action="logout" aria-label="تسجيل الخروج" title="تسجيل الخروج">↪</button>`;
}

function metricCard(label, value, icon, color = "", format = "money") {
  const displayValue = format === "percent"
    ? `${new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 2 }).format(Number(value) || 0)}%`
    : money(value);
  return `<article class="metric-card ${color}"><div><span class="metric-label">${escapeHtml(label)}</span><strong class="metric-value">${displayValue}</strong></div><span class="metric-icon">${icon}</span></article>`;
}

function chartMarkup() {
  const months = summary.months || [];
  const max = Math.max(1, ...months.flatMap((month) => [month.sales, month.purchases]));
  const chart = months.length
    ? months.map((month) => `<div class="chart-group" title="${escapeHtml(month.month)}"><span class="bar blue" style="height:${Math.max(2, month.sales / max * 100)}%"></span><span class="bar" style="height:${Math.max(2, month.purchases / max * 100)}%"></span></div>`).join("")
    : `<div class="empty-state"><div><span>▥</span>سيظهر الرسم البياني بعد تسجيل المبيعات</div></div>`;
  return `<div class="chart">${chart}</div>${months.length ? `<div class="chart-labels">${months.map((month) => `<span>${escapeHtml(month.month)}</span>`).join("")}</div><div class="legend"><span><i></i>المبيعات</span><span><i></i>المشتريات</span></div>` : ""}`;
}

function dashboard() {
  const cards = [
    ["إجمالي مبيعات اليوم", summary.todaySales, "↓"],
    ["إجمالي مشتريات اليوم", summary.todayPurchases, "↓"],
    [" الفرق بين المبيعات والمشتريات", summary.netSales, "↓"],
    [" نسبة المشتريات مقارنة بالمبيعات", summary.purchasePercentage, "↗", "", "percent"],
    ["إجمالي الإيرادات", summary.revenue, "▤"],
    ["إجمالي المصروفات", summary.expenses, "▯"],
    [" إجمالي المديونيات", summary.creditSales, "▣"],
    ["إجمالي التوريدات", summary.supplies, "▱"],
    ...paymentMethods.map(({ value, label }) => [`رصيد ${label}`, summary.paymentBalances?.[value], "⌁"]),
    ...Object.entries(summary.paymentBalances || {})
      .filter(([method, balance]) => !paymentMethods.some((item) => item.value === method) && balance !== 0)
      .map(([method, balance]) => [`رصيد ${paymentMethodLabels[method] || method}`, balance, "⌁"]),
  ];
  const pharmacyRows = pharmacies.map((pharmacy) => [
    escapeHtml(pharmacy.name),
    money(pharmacy.sales),
    money(pharmacy.purchases),
    money(pharmacy.balance),
  ]);
  return `<div class="page-wrap">
    <div class="page-heading"><div class="heading-title"><span class="heading-icon">⌂</span><div><h1>الرئيسية</h1><p class="subtitle">ملخص الصيدليات والحركات المسجلة</p></div></div><button class="period-chip" data-action="refresh">↻ تحديث</button></div>
    ${errorMessage ? `<div class="error-banner" role="alert">${escapeHtml(errorMessage)}<button data-action="retry">إعادة المحاولة</button></div>` : ""}
    ${loading ? `<div class="section-card loading">جارٍ تحميل البيانات…</div>` : ""}
    <section class="hero"><div class="hero-topline"><span class="hero-date">${new Date().toLocaleDateString("ar-EG", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span><span class="hero-updated">آخر تحديث · الآن</span></div><p class="eyebrow">مرحباً بعودتك</p><h2>أهلاً ${escapeHtml(currentUser?.displayName || "")} <span class="hero-separator">·</span> ${canManage() ? "مدير النظام" : currentUser?.role === "branch_manager" ? "مدير الفرع" : "مستخدم"}</h2><div class="hero-metrics"><div class="hero-metric"><small>إجمالي أرصدة الخزائن</small><strong>${money(summary.cashBalance)}</strong></div><div class="hero-metric"><small>نفقات اليوم</small><strong>${money(summary.todayExpenses)}</strong></div><div class="hero-metric"><small>الصيدليات</small><strong>${Number(summary.pharmacyCount) || 0}</strong></div><div class="hero-metric"><small>متبقي المديونيات</small><strong>${money(summary.creditSales)}</strong></div></div></section>
    <div class="metrics-grid">${cards.map(([label, value, icon, color, format]) => metricCard(label, value, icon, color, format)).join("")}</div>
    ${section("المبيعات والمشتريات", chartMarkup(), `<a href="#" data-page="المبيعات">التفاصيل «</a>`)}
    ${section("أرصدة الصيدليات", table(["الصيدلية", "المبيعات", "المشتريات", "الرصيد"], pharmacyRows), `<a href="#" data-page="الصيدليات">عرض الفروع «</a>`)}
    ${section("آخر الحركات", transactionTable(transactions.slice(0, 5)))}
  </div>`;
}

function transactionTable(records) {
  return table(
    ["التاريخ", "الصيدلية", "النوع", "الوردية", "طريقة الدفع", "الوصف", "المبلغ", ...(hasPermission("delete_transactions") ? ["الإجراء"] : [])],
    records.map((item) => [
      escapeHtml(item.date),
      escapeHtml(item.pharmacyName),
      escapeHtml(transactionTypes[item.type] || item.type),
      item.shiftTemplateId
        ? `${escapeHtml(item.shiftTemplateName)} · ${escapeHtml(item.shiftTemplateStartTime)}–${escapeHtml(item.shiftTemplateEndTime)}`
        : item.shiftId ? `${escapeHtml(item.shiftStartTime)}–${escapeHtml(item.shiftEndTime)} · ${escapeHtml(item.shiftUserName || "مستخدم محذوف")}` : "—",
      Object.keys(item.paymentSplits || {}).length
        ? Object.entries(item.paymentSplits)
          .filter(([, amount]) => amount > 0)
          .map(([method, amount]) => `${escapeHtml(paymentMethodLabels[method] || method)}: ${money(amount)}`)
          .join(" · ")
        : escapeHtml(paymentMethodLabels[item.paymentMethod] || item.paymentMethod),
      escapeHtml(item.description || "—"),
      money(item.amount),
      ...(hasPermission("delete_transactions") ? [`<button class="text-danger" data-delete-transaction="${item.id}" aria-label="حذف الحركة">حذف</button>`] : []),
    ]),
  );
}

function pharmacyForm() {
  return `<form class="entry-form" id="pharmacy-form">
    <label>اسم الصيدلية<input name="name" required maxlength="120" placeholder="مثال: صيدلية المدينة"></label>
    <label>العنوان (اختياري)<input name="location" maxlength="200" placeholder="المدينة أو العنوان"></label>
    <div class="branch-shift-editor">
      <div class="branch-shift-heading"><strong>جدول الشيفتات اليومي</strong><small>حدد وردية واحدة على الأقل، ويمكن إضافة ورديات أخرى.</small></div>
      <div class="branch-shift-rows">${branchShiftTemplateRow()}</div>
      <button class="period-chip" type="button" data-action="add-branch-shift">إضافة وردية أخرى</button>
    </div>
    <button class="primary-button" type="submit">إضافة صيدلية</button>
  </form>`;
}

function branchShiftTemplateRow() {
  return `<div class="branch-shift-row">
    <label>اسم الوردية<input name="shiftName" required maxlength="60" placeholder="مثال: صباحية"></label>
    <label>من<input name="shiftStartTime" type="time" required></label>
    <label>إلى<input name="shiftEndTime" type="time" required></label>
    <button class="text-danger" type="button" data-action="remove-branch-shift" aria-label="حذف الوردية">حذف</button>
  </div>`;
}

function saleShiftAvailabilityMessage(form) {
  const pharmacyId = form
    ? form.querySelector('[name="pharmacyId"]')?.value
    : saleFormValues.pharmacyId || currentUser?.pharmacyId;
  if (!pharmacyId) return "اختر الفرع لعرض وردياته.";
  if (saleShiftOptions.length) return "";
  return "لا توجد ورديات معرفة لهذا الفرع. أضف ورديات من بيانات الفرع.";
}

function transactionForm(type) {
  const assignedPharmacy = pharmacies.find((pharmacy) => pharmacy.id === currentUser?.pharmacyId);
  const selectablePharmacies = canManage() ? pharmacies : assignedPharmacy ? [assignedPharmacy] : [];
  const pharmacyOptions = selectablePharmacies.map((pharmacy) => `<option value="${pharmacy.id}" ${!canManage() || (type === "sale" && String(saleFormValues.pharmacyId) === String(pharmacy.id)) ? "selected" : ""}>${escapeHtml(pharmacy.name)}</option>`).join("");
  const shiftSelector = type === "sale"
    ? `<label>الوردية<select name="shiftTemplateId" required ${saleShiftOptions.length ? "" : "disabled"}><option value="">${saleShiftOptions.length ? "اختر الوردية" : "لا توجد ورديات معرفة للفرع"}</option>${saleShiftOptions.map((shift) => `<option value="${shift.id}" ${String(saleFormValues.shiftTemplateId) === String(shift.id) ? "selected" : ""}>${escapeHtml(shift.name)} · ${escapeHtml(shift.startTime)}–${escapeHtml(shift.endTime)}</option>`).join("")}</select></label><p class="form-note" id="sale-shift-note">${escapeHtml(saleShiftAvailabilityMessage(null))}</p>`
    : "";
  const availablePaymentMethods = type === "supply" ? supplyPaymentMethods : paymentMethods;
  const paymentMethodField = type === "sale"
    ? `<fieldset class="sale-payment-splits"><legend>المبلغ حسب طريقة الدفع</legend><p class="form-note">أدخل الجزء المحصل بكل طريقة. يجب أن يساوي مجموعها إجمالي مبلغ البيع.</p><div class="sale-payment-grid">${paymentMethods.map(({ value, label }) => `<label>${escapeHtml(label)}<input name="paymentSplit_${value}" type="number" min="0" step="0.01" required value="0" placeholder="0.00"></label>`).join("")}</div></fieldset>`
    : `<label>${type === "supply" ? "التحويل من" : "طريقة الدفع"}<select name="paymentMethod">${availablePaymentMethods.map(({ value, label }) => `<option value="${value}">${escapeHtml(label)}</option>`).join("")}</select></label>`;
  return `<form class="entry-form transaction-form" id="transaction-form">
    <input name="type" type="hidden" value="${type}">
    <label>الفرع<select name="pharmacyId" required ${!canManage() || !selectablePharmacies.length ? "disabled" : ""}><option value="">اختر الفرع</option>${pharmacyOptions}</select></label>
    <label>نوع الحركة<input value="${escapeHtml(transactionTypes[type])}" readonly></label>
    <label>المبلغ<input name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00"></label>
    <label>التاريخ<input name="date" type="date" required value="${escapeHtml(type === "sale" ? saleFormValues.date || new Date().toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10))}"></label>
    ${shiftSelector}
    ${paymentMethodField}
    ${["purchase", "expense", "supply"].includes(type) ? `<p class="form-note">${type === "supply" ? "يُخصم المبلغ من طريقة الدفع المختارة ويُضاف إلى رصيد النقدي. " : ""}يجب أن يتوفر رصيد كافٍ في طريقة الدفع المختارة لتسجيل الحركة.</p>` : ""}
    <label>الوصف<input name="description" maxlength="300" placeholder="تفاصيل الحركة (اختياري)"></label>
    <button class="primary-button" type="submit" ${selectablePharmacies.length && (type !== "sale" || saleShiftOptions.length) ? "" : "disabled"}>تسجيل الحركة</button>
    ${selectablePharmacies.length ? "" : `<p class="form-note">${canManage() ? "أضف صيدلية أولاً حتى تتمكن من تسجيل الحركات." : "لا يوجد فرع مخصص لهذا الحساب."}</p>`}
  </form>`;
}

function userForm() {
  const pharmacyOptions = pharmacies.map((pharmacy) => `<option value="${pharmacy.id}">${escapeHtml(pharmacy.name)}</option>`).join("");
  return `<form class="entry-form users-form" id="user-form">
    <label>الاسم الظاهر<input name="displayName" required maxlength="100" placeholder="اسم الموظف"></label>
    <label>اسم المستخدم<input name="username" required minlength="3" maxlength="40" pattern="[A-Za-z0-9_.-]+" autocomplete="off" placeholder="user.name"></label>
    <label>كلمة المرور<input name="password" required type="password" minlength="12" maxlength="128" autocomplete="new-password" placeholder="12 حرفاً على الأقل"></label>
    <label>الفرع المخصص<select name="pharmacyId" required ${pharmacies.length ? "" : "disabled"}><option value="">اختر الصيدلية</option>${pharmacyOptions}</select></label>
    <label>الدور<select name="role"><option value="user">مستخدم</option><option value="branch_manager">مدير فرع</option><option value="admin">مدير النظام</option></select></label>
    <fieldset class="permissions-fieldset" data-permissions-section>
      <legend>الصلاحيات</legend>
      <label><input type="checkbox" name="permissions" value="view_data" checked> عرض لوحة المعلومات والحركات والتقارير</label>
      <label><input type="checkbox" name="permissions" value="record_transactions" checked> تسجيل الحركات</label>
      <label><input type="checkbox" name="permissions" value="close_shifts" checked> إغلاق الشيفتات المخصصة للحساب</label>
      <label><input type="checkbox" name="permissions" value="manage_shifts"> إدارة ورديات الفرع</label>
      <label><input type="checkbox" name="permissions" value="delete_transactions"> حذف حركات الفرع</label>
    </fieldset>
    <button class="primary-button" type="submit">إنشاء الحساب</button>
    ${pharmacies.length ? "" : `<p class="form-note">أضف صيدلية أولاً حتى تتمكن من إنشاء حساب مستخدم مرتبط بفرع.</p>`}
  </form>`;
}

function usersTable() {
  return table(
    ["الاسم", "اسم المستخدم", "الدور", "الصلاحيات", "الفرع", "تاريخ الإنشاء", "الإجراء"],
    users.map((user) => [
      escapeHtml(user.displayName),
      escapeHtml(user.username),
      `<span class="users-role ${user.role === "admin" ? "admin" : user.role === "branch_manager" ? "branch-manager" : ""}">${user.role === "admin" ? "مدير النظام" : user.role === "branch_manager" ? "مدير فرع" : "مستخدم"}</span>`,
      escapeHtml(user.role === "admin" ? "كافة الصلاحيات" : (user.permissions || []).map((permission) => permissionLabels[permission] || permission).join("، ") || "بدون صلاحيات"),
      escapeHtml(user.pharmacyName || (user.role === "admin" ? "كل الفروع" : "غير محدد")),
      escapeHtml(user.createdAt),
      `<button class="text-danger" data-edit-user="${user.id}">تعديل البيانات والصلاحيات</button>${user.id === currentUser.id ? " حسابك الحالي" : ` <button class="text-danger" data-delete-user="${user.id}">حذف الحساب</button>`}`,
    ]),
  );
}

function editUserForm(user) {
  const pharmacyOptions = pharmacies.map((pharmacy) => `<option value="${pharmacy.id}" ${Number(user.pharmacyId) === pharmacy.id ? "selected" : ""}>${escapeHtml(pharmacy.name)}</option>`).join("");
  const selectedPermissions = new Set(user.permissions || []);
  const adminRole = user.role === "admin";
  return `<form class="entry-form users-form" id="edit-user-form">
    <input name="userId" type="hidden" value="${user.id}">
    <label>الاسم الظاهر<input name="displayName" required maxlength="100" value="${escapeHtml(user.displayName)}"></label>
    <label>اسم المستخدم<input name="username" required minlength="3" maxlength="40" pattern="[A-Za-z0-9_.-]+" autocomplete="off" value="${escapeHtml(user.username)}"></label>
    <label>كلمة مرور جديدة (اختياري)<input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" placeholder="اتركها فارغة للإبقاء على كلمة المرور"></label>
    <label>الفرع المخصص<select name="pharmacyId" ${adminRole ? "disabled" : "required"} ${pharmacies.length ? "" : "disabled"}><option value="">اختر الصيدلية</option>${pharmacyOptions}</select></label>
    <label>الدور<select name="role"><option value="user" ${user.role === "user" ? "selected" : ""}>مستخدم</option><option value="branch_manager" ${user.role === "branch_manager" ? "selected" : ""}>مدير فرع</option><option value="admin" ${adminRole ? "selected" : ""}>مدير النظام</option></select></label>
    <fieldset class="permissions-fieldset" data-permissions-section ${adminRole ? "hidden" : ""}>
      <legend>الصلاحيات</legend>
      ${Object.entries(permissionLabels).map(([permission, label]) => `<label><input type="checkbox" name="permissions" value="${permission}" ${selectedPermissions.has(permission) ? "checked" : ""}> ${escapeHtml(label)}</label>`).join("")}
    </fieldset>
    <button class="primary-button" type="submit">حفظ بيانات المستخدم</button>
    <button class="period-chip" type="button" data-action="cancel-user-edit">إلغاء</button>
  </form>`;
}

function shiftForm(shift = null) {
  const pharmacyId = shift?.pharmacyId || "";
  const branchUsers = users.filter((user) => ["user", "branch_manager"].includes(user.role) && Number(user.pharmacyId) === Number(pharmacyId));
  const employeeOptions = branchUsers.map((user) => `<option value="${user.id}" ${Number(shift?.userId) === user.id ? "selected" : ""}>${escapeHtml(user.displayName)}</option>`).join("");
  return `<form class="entry-form" id="shift-form">
    <label>الفرع<select name="pharmacyId" required ${pharmacies.length ? "" : "disabled"}><option value="">اختر الفرع</option>${pharmacies.map((pharmacy) => `<option value="${pharmacy.id}" ${Number(pharmacyId) === pharmacy.id ? "selected" : ""}>${escapeHtml(pharmacy.name)}</option>`).join("")}</select></label>
    <label>المستخدم<select name="userId" required ${branchUsers.length ? "" : "disabled"}><option value="">${branchUsers.length ? "اختر المستخدم" : "اختر الفرع أولاً أو أضف مستخدماً للفرع"}</option>${employeeOptions}</select></label>
    <label>التاريخ<input name="date" type="date" required value="${escapeHtml(shift?.date || new Date().toISOString().slice(0, 10))}"></label>
    <label>وقت البداية<input name="startTime" type="time" required value="${escapeHtml(shift?.startTime || "")}"></label>
    <label>وقت النهاية<input name="endTime" type="time" required value="${escapeHtml(shift?.endTime || "")}"></label>
    <label>ملاحظات<input name="notes" maxlength="300" value="${escapeHtml(shift?.notes || "")}" placeholder="ملاحظات اختيارية"></label>
    <button class="primary-button" type="submit" ${pharmacies.length && branchUsers.length ? "" : "disabled"}>${shift ? "حفظ التعديلات" : "إضافة الوردية"}</button>
    ${shift ? `<button class="period-chip" type="button" data-action="cancel-shift-edit">إلغاء التعديل</button>` : ""}
    ${!pharmacies.length ? `<p class="form-note">أضف فرعاً أولاً قبل إنشاء الشيفتات.</p>` : ""}
  </form>`;
}

function shiftSalesForm(shift) {
  return `<form class="entry-form shift-sales-form" id="shift-sales-form">
    <input name="shiftId" type="hidden" value="${shift.id}">
    <p class="form-note">${escapeHtml(shift.pharmacyName)} · ${escapeHtml(shift.userName || "مستخدم محذوف")} · ${escapeHtml(shift.date)} · ${escapeHtml(shift.startTime)}–${escapeHtml(shift.endTime)}</p>
    <label>إجمالي مبيعات الوردية<input name="salesAmount" type="number" min="0" max="1000000000000" step="0.01" required value="${shift.salesAmount ?? ""}" placeholder="0.00"></label>
    <button class="primary-button" type="submit">${shift.salesAmount === null ? "إغلاق الوردية وحفظ المبيعات" : "حفظ تعديل المبيعات"}</button>
    <button class="period-chip" type="button" data-action="cancel-shift-close">إلغاء</button>
  </form>`;
}

function formatMonth(month) {
  const [year, value] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("ar-EG", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, value - 1, 1)));
}

function shiftAnalyticsChart(title, currentLabel, previousLabel, currentKey, previousKey) {
  const rows = shiftAnalytics?.shifts || [];
  if (!rows.length) return section(title, `<div class="empty-state"><div><span>▥</span>لا توجد ورديات أو مبيعات مسجلة للمقارنة.</div></div>`);
  const max = Math.max(1, ...rows.flatMap((shift) => [shift[currentKey], shift[previousKey]]));
  const chart = rows.map((shift) => `
    <div class="shift-chart-row">
      <strong>${escapeHtml(shift.pharmacyName)} · ${escapeHtml(shift.name)}</strong>
      ${[[currentLabel, shift[currentKey], "current"], [previousLabel, shift[previousKey], "previous"]].map(([label, amount, color]) => `
        <div class="shift-chart-series">
          <span>${escapeHtml(label)}</span>
          <div class="shift-chart-track"><i class="shift-chart-bar ${color}" style="width:${Math.max(amount ? 1 : 0, amount / max * 100)}%"></i></div>
          <b>${money(amount)}</b>
        </div>`).join("")}
    </div>`).join("");
  return section(title, `<div class="shift-chart-list">${chart}</div><div class="legend shift-chart-legend"><span><i class="current"></i>${escapeHtml(currentLabel)}</span><span><i class="previous"></i>${escapeHtml(previousLabel)}</span></div>`);
}

function shiftAnalyticsTable() {
  if (!shiftAnalytics) return `<div class="section-card loading">جارٍ تحميل تحليلات الشيفتات…</div>`;
  const { currentMonth, previousMonth, currentMonthDays, previousMonthDays, shifts: rows } = shiftAnalytics;
  if (!rows.length) return `<div class="empty-state"><div><span>▥</span>لا توجد ورديات معرفة لعرض التحليلات.</div></div>`;
  return table(
    ["الفرع", "الوردية", `إجمالي ${formatMonth(currentMonth)}`, `متوسط اليوم · ${currentMonthDays} يوم`, `إجمالي ${formatMonth(previousMonth)}`, `متوسط اليوم · ${previousMonthDays} يوم`],
    rows.map((shift) => [
      escapeHtml(shift.pharmacyName),
      `${escapeHtml(shift.name)} · ${escapeHtml(shift.startTime)}–${escapeHtml(shift.endTime)}`,
      money(shift.currentSales),
      money(shift.currentAverage),
      money(shift.previousSales),
      money(shift.previousAverage),
    ]),
  );
}

function shiftsTable() {
  return table(
    ["الفرع", "المستخدم", "التاريخ", "من", "إلى", "مبيعات الوردية", "ملاحظات", "الإجراء"],
    shifts.map((shift) => {
      const sales = shift.salesAmount === null ? "لم تُغلق" : money(shift.salesAmount);
      const actions = [];
      if (canManageShifts()) {
        actions.push(`<button class="text-danger" data-edit-shift="${shift.id}">تعديل الوردية</button>`);
        actions.push(`<button class="text-danger" data-delete-shift="${shift.id}">حذف</button>`);
      }
      if (canManageShifts() || (hasPermission("close_shifts") && shift.userId === currentUser.id && shift.salesAmount === null)) {
        actions.push(`<button class="text-danger" data-close-shift="${shift.id}">${shift.salesAmount === null ? "تسجيل المبيعات" : "تعديل المبيعات"}</button>`);
      }
      return [
        escapeHtml(shift.pharmacyName),
        escapeHtml(shift.userName || "مستخدم محذوف"),
        escapeHtml(shift.date),
        escapeHtml(shift.startTime),
        escapeHtml(shift.endTime),
        sales,
        escapeHtml(shift.notes || "—"),
        actions.join(" "),
      ];
    }),
  );
}

function filters() {
  const values = filterValuesByPage[currentPage] || {};
  const assignedPharmacy = pharmacies.find((pharmacy) => pharmacy.id === currentUser?.pharmacyId);
  const branchOptions = canManage()
    ? pharmacies.map((pharmacy) => `<option value="${pharmacy.id}" ${String(values.pharmacyId) === String(pharmacy.id) ? "selected" : ""}>${escapeHtml(pharmacy.name)}</option>`).join("")
    : "";
  return `<form class="filter-bar" id="filter-form"><label>الفرع<select name="pharmacyId" ${!canManage() ? "disabled" : ""}><option value="">${canManage() ? "كل الفروع" : escapeHtml(assignedPharmacy?.name || "لا يوجد فرع مخصص")}</option>${branchOptions}</select></label><label>من تاريخ<input name="from" type="date" value="${escapeHtml(values.from || "")}"></label><label>إلى تاريخ<input name="to" type="date" value="${escapeHtml(values.to || "")}"></label><label>طريقة الدفع<select name="paymentMethod"><option value="">كل طرق الدفع</option>${Object.entries(paymentMethodLabels).map(([value, label]) => `<option value="${value}" ${values.paymentMethod === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label><button class="primary-button" type="submit">تطبيق التصفية</button></form>`;
}

function pharmacyCards() {
  if (!pharmacies.length) return `<div class="empty-state"><div><span>▦</span>لا توجد صيدليات. أضف أول صيدلية من النموذج أعلاه.</div></div>`;
  return `<div class="pharmacy-grid">${pharmacies.map((pharmacy) => `<article class="pharmacy-card"><div class="pharmacy-banner"><span><strong>${escapeHtml(pharmacy.name)}</strong><small>${escapeHtml(pharmacy.location || "بدون عنوان")}</small></span><span>✚</span></div><div class="branch-shift-schedule"><strong>الشيفتات اليومية</strong>${pharmacy.shifts?.length ? pharmacy.shifts.map((shift) => `<span>${escapeHtml(shift.name)} · ${escapeHtml(shift.startTime)}–${escapeHtml(shift.endTime)}</span>`).join("") : `<span>لم يحدد جدول الشيفتات</span>`}</div><div class="mini-stats"><div class="mini-stat"><small>إجمالي المبيعات</small><strong>${money(pharmacy.sales)}</strong></div><div class="mini-stat"><small>إجمالي المشتريات</small><strong>${money(pharmacy.purchases)}</strong></div><div class="mini-stat"><small>الرصيد</small><strong>${money(pharmacy.balance)}</strong></div><div class="mini-stat"><small>عدد الحركات</small><strong>${Number(pharmacy.transactionCount) || 0}</strong></div></div>${canManage() ? `<button class="text-danger delete-pharmacy" data-delete-pharmacy="${pharmacy.id}">حذف الصيدلية وبياناتها</button>` : ""}</article>`).join("")}</div>`;
}

function pageHeading(pageName) {
  const page = pages.find((item) => item.name === pageName);
  const subtitle = pageName === "الشيفتات"
    ? "مبيعات كل وردية ومتوسطها اليومي مقارنة بالشهر السابق"
    : "إدارة البيانات المسجلة في قاعدة البيانات";
  return `<div class="page-heading"><div class="heading-title"><span class="heading-icon">${page?.icon || "▤"}</span><div><h1>${escapeHtml(pageName)}</h1><p class="subtitle">${escapeHtml(subtitle)}</p></div></div></div>`;
}

function pageView() {
  if (currentPage === "الرئيسية") return dashboard();
  if (currentPage === "المستخدمون") {
    if (!canManage()) return `<div class="page-wrap">${pageHeading(currentPage)}<div class="error-banner">هذه الصفحة متاحة للمدير فقط.</div></div>`;
    const editingUser = users.find((user) => user.id === editingUserId);
    return `<div class="page-wrap">${pageHeading(currentPage)}${errorMessage ? `<div class="error-banner" role="alert">${escapeHtml(errorMessage)}</div>` : ""}${section("إنشاء حساب مستخدم أو مدير فرع", userForm(), "")}${editingUser ? section(`تحديث بيانات وصلاحيات ${editingUser.displayName}`, editUserForm(editingUser), "") : ""}${section("تحديث بيانات المستخدمين والصلاحيات", usersTable(), "")}</div>`;
  }
  if (currentPage === "الصيدليات") {
    return `<div class="page-wrap">${pageHeading(currentPage)}${errorMessage ? `<div class="error-banner" role="alert">${escapeHtml(errorMessage)}</div>` : ""}${canManage() ? section("إضافة صيدلية", pharmacyForm(), "") : ""}${section("الصيدليات المسجلة", pharmacyCards(), "")}</div>`;
  }
  if (currentPage === "الشيفتات") {
    const editingShift = shifts.find((shift) => shift.id === editingShiftId);
    const closingShift = shifts.find((shift) => shift.id === closingShiftId);
    const analytics = shiftAnalytics
      ? `${shiftAnalyticsChart("إجمالي المبيعات لكل وردية", formatMonth(shiftAnalytics.currentMonth), formatMonth(shiftAnalytics.previousMonth), "currentSales", "previousSales")}${shiftAnalyticsChart("متوسط المبيعات اليومي لكل وردية", `متوسط ${formatMonth(shiftAnalytics.currentMonth)}`, `متوسط ${formatMonth(shiftAnalytics.previousMonth)}`, "currentAverage", "previousAverage")}${section("ملخص الشيفتات الشهري", shiftAnalyticsTable(), "")}`
      : loading
        ? `<div class="section-card loading">جارٍ تحميل تحليلات الشيفتات…</div>`
        : `<div class="empty-state"><div><span>▥</span>تعذر تحميل التحليلات.<button class="period-chip" data-action="retry">إعادة المحاولة</button></div></div>`;
    return `<div class="page-wrap">${pageHeading(currentPage)}${errorMessage ? `<div class="error-banner" role="alert">${escapeHtml(errorMessage)}</div>` : ""}${analytics}${canManageShifts() ? section(editingShift ? "تعديل الوردية" : "إضافة وردية", shiftForm(editingShift), "") : ""}${closingShift ? section(closingShift.salesAmount === null ? "إغلاق الوردية" : "تعديل مبيعات الوردية", shiftSalesForm(closingShift), "") : ""}${section("جدول الشيفتات", shiftsTable(), "")}</div>`;
  }
  if (currentPage === "التقارير") {
    return `<div class="page-wrap">${pageHeading(currentPage)}${filters()}${section("تقرير الحركات", transactionTable(transactions), "")}</div>`;
  }
  const transactionView = transactionPages.has(currentPage);
  const type = typeForPage(currentPage);
  return `<div class="page-wrap">${pageHeading(currentPage)}${errorMessage ? `<div class="error-banner" role="alert">${escapeHtml(errorMessage)}</div>` : ""}${transactionView && hasPermission("record_transactions") ? section(`تسجيل ${transactionTypes[type]}`, transactionForm(type), "") : ""}${filters()}${section(`سجل ${escapeHtml(currentPage)}`, transactionTable(transactions), "")}</div>`;
}

function authScreen() {
  const setup = authState?.setupRequired === true;
  const heading = setup ? "إعداد حساب المدير" : "تسجيل الدخول";
  const description = setup
    ? "أنشئ حساب المدير الأول لبدء تأمين نظام إدارة الصيدليات. لا يمكن إنشاء مدير أول آخر بعد اكتمال هذه الخطوة."
    : "سجّل الدخول باستخدام الحساب الذي أنشأه مدير النظام.";
  return `<div class="auth-screen"><section class="auth-card"><div class="auth-logo"><span class="brand-mark">+</span><span>إدارة الصيدليات</span></div><h1>${heading}</h1><p class="auth-description">${description}</p>${authError ? `<div class="error-banner" role="alert">${escapeHtml(authError)}</div>` : ""}<form class="auth-form" id="auth-form" data-mode="${setup ? "setup" : "login"}">${setup ? `<label>الاسم الظاهر<input name="displayName" required maxlength="100" autocomplete="name" placeholder="اسم مدير النظام"></label>` : ""}<label>اسم المستخدم<input name="username" required minlength="3" maxlength="40" autocomplete="username" placeholder="username"></label><label>كلمة المرور<input name="password" required type="password" minlength="${setup ? 12 : 1}" maxlength="128" autocomplete="${setup ? "new-password" : "current-password"}" placeholder="${setup ? "12 حرفاً على الأقل" : "أدخل كلمة المرور"}"></label><button class="primary-button" type="submit">${setup ? "إنشاء حساب المدير" : "تسجيل الدخول"}</button></form>${setup ? `<p class="auth-hint">كلمة المرور مطلوبة بطول 12 حرفاً على الأقل. بعد إنشاء المدير، يمكنه إضافة المستخدمين وتحديد صلاحياتهم من صفحة المستخدمين.</p>` : ""}</section></div>`;
}

function render() {
  const authenticated = Boolean(currentUser);
  shell.classList.toggle("auth-mode", !authenticated);
  if (!authenticated) {
    content.innerHTML = authScreen();
    mobileMenu.hidden = true;
    document.title = authState?.setupRequired ? "إعداد المدير | إدارة الصيدليات" : "تسجيل الدخول | إدارة الصيدليات";
    return;
  }
  navigation.innerHTML = navMarkup();
  mobileNavigation.innerHTML = mobileNavMarkup();
  mobileNavigation.hidden = !hasPermission("view_data");
  mobileMenu.innerHTML = menuMarkup();
  accountArea.innerHTML = accountMarkup();
  const roleName = canManage() ? "مدير النظام" : currentUser.role === "branch_manager" ? "مدير الفرع" : "مستخدم";
  document.querySelector("#mobile-user-role").textContent = `${currentUser.displayName} · ${roleName}`;
  document.querySelector(".header-add").hidden = !hasPermission("record_transactions");
  content.innerHTML = hasPermission("view_data")
    ? pageView()
    : `<div class="page-wrap"><div class="error-banner" role="alert">لا توجد صلاحيات لعرض بيانات النظام. تواصل مع مدير النظام لتحديث صلاحيات حسابك.</div></div>`;
  document.title = `${currentPage} | إدارة الصيدليات`;
}

async function submitForm(form, endpoint, method = "POST") {
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    payload.permissions = formData.getAll("permissions");
    if (payload.pharmacyId) payload.pharmacyId = Number(payload.pharmacyId);
    if (payload.amount) payload.amount = Number(payload.amount);
    await api(endpoint, { method, body: JSON.stringify(payload) });
    if (form.id === "edit-user-form") editingUserId = null;
    await loadData();
  } catch (error) {
    errorMessage = error.message;
    render();
  }
}

async function submitPharmacyForm(form) {
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.shiftTemplates = [...form.querySelectorAll(".branch-shift-row")].map((row) => ({
      name: row.querySelector('[name="shiftName"]').value,
      startTime: row.querySelector('[name="shiftStartTime"]').value,
      endTime: row.querySelector('[name="shiftEndTime"]').value,
    }));
    delete payload.shiftName;
    delete payload.shiftStartTime;
    delete payload.shiftEndTime;
    await api("/api/pharmacies", { method: "POST", body: JSON.stringify(payload) });
    await loadData();
  } catch (error) {
    errorMessage = error.message;
    render();
  }
}

async function submitShiftForm(form) {
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  const shiftId = editingShiftId;
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.pharmacyId = Number(payload.pharmacyId);
  payload.userId = Number(payload.userId);
  try {
    await api(shiftId ? `/api/shifts/${shiftId}` : "/api/shifts", {
      method: shiftId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    editingShiftId = null;
    await loadData();
  } catch (error) {
    errorMessage = error.message;
    render();
  }
}

async function submitShiftSalesForm(form) {
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  const shiftId = Number(new FormData(form).get("shiftId"));
  const salesAmount = Number(new FormData(form).get("salesAmount"));
  try {
    await api(`/api/shifts/${shiftId}/close`, {
      method: "POST",
      body: JSON.stringify({ salesAmount }),
    });
    closingShiftId = null;
    await loadData();
  } catch (error) {
    errorMessage = error.message;
    render();
  }
}

async function submitTransactionForm(form) {
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(form).entries());
  if (payload.type === "sale") {
    payload.paymentSplits = Object.fromEntries(paymentMethods.map(({ value }) => [
      value,
      Number(payload[`paymentSplit_${value}`]),
    ]));
    for (const { value } of paymentMethods) delete payload[`paymentSplit_${value}`];
    const splitTotal = Object.values(payload.paymentSplits).reduce((total, amount) => total + Math.round(amount * 100), 0);
    if (splitTotal !== Math.round(Number(payload.amount) * 100)) {
      errorMessage = "يجب أن يساوي مجموع مبالغ طرق الدفع إجمالي مبلغ البيع.";
      render();
      return;
    }
  }
  if (!payload.pharmacyId && !canManage()) payload.pharmacyId = currentUser.pharmacyId;
  payload.pharmacyId = Number(payload.pharmacyId);
  payload.amount = Number(payload.amount);
  if (payload.shiftTemplateId) payload.shiftTemplateId = Number(payload.shiftTemplateId);
  try {
    await api(`/api/transactions/${encodeURIComponent(payload.type)}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await loadData();
  } catch (error) {
    errorMessage = error.message;
    render();
  }
}

async function handleAuth(form) {
  const button = form.querySelector("button");
  button.disabled = true;
  authError = "";
  try {
    const endpoint = form.dataset.mode === "setup" ? "/api/auth/setup" : "/api/auth/login";
    const result = await api(endpoint, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
    currentUser = result.user;
    authState = { setupRequired: false, user: result.user };
    await loadData();
  } catch (error) {
    authError = error.message;
    render();
  }
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    currentUser = null;
    authState = { setupRequired: false, user: null };
    authError = "";
    currentPage = "الرئيسية";
    shifts = [];
    editingShiftId = null;
    closingShiftId = null;
    saleShiftOptions = [];
    saleFormValues = {};
    render();
  } catch (error) {
    errorMessage = error.message;
    render();
  }
}

async function applyFilters(form) {
  filterValuesByPage[currentPage] = Object.fromEntries(new FormData(form).entries());
  try {
    transactions = await api(`/api/transactions?${transactionQuery(currentPage)}`);
    errorMessage = "";
    render();
  } catch (error) {
    errorMessage = error.message;
    render();
  }
}

async function refreshSaleShifts(form) {
  const templateField = form.querySelector('[name="shiftTemplateId"]');
  if (!templateField) return;
  const pharmacyId = form.querySelector('[name="pharmacyId"]').value;
  saleFormValues = { ...saleFormValues, pharmacyId, shiftTemplateId: "" };
  saleShiftOptions = pharmacyId
    ? pharmacies.find((pharmacy) => String(pharmacy.id) === String(pharmacyId))?.shifts || []
    : [];
  templateField.innerHTML = `<option value="">${saleShiftOptions.length ? "اختر الوردية" : "لا توجد ورديات معرفة للفرع"}</option>${saleShiftOptions.map((shift) => `<option value="${shift.id}">${escapeHtml(shift.name)} · ${escapeHtml(shift.startTime)}–${escapeHtml(shift.endTime)}</option>`).join("")}`;
  templateField.disabled = !saleShiftOptions.length;
  form.querySelector('[type="submit"]').disabled = !saleShiftOptions.length;
  const note = form.querySelector("#sale-shift-note");
  if (note) note.textContent = saleShiftAvailabilityMessage(form);
}

document.addEventListener("click", async (event) => {
  const pageLink = event.target.closest("[data-page]");
  if (pageLink) {
    event.preventDefault();
    currentPage = pageLink.dataset.page;
    if (currentPage !== "الشيفتات") {
      editingShiftId = null;
      closingShiftId = null;
    }
    mobileMenu.hidden = true;
    await loadData();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "logout") {
    await logout();
    return;
  }
  if (action === "cancel-user-edit") {
    editingUserId = null;
    errorMessage = "";
    render();
    return;
  }
  if (action === "toggle-menu") {
    mobileMenu.hidden = !mobileMenu.hidden;
    event.target.closest("[data-action]").setAttribute("aria-expanded", String(!mobileMenu.hidden));
    return;
  }
  if (action === "quick-add") {
    currentPage = "المبيعات";
    await loadData();
    return;
  }
  if (action === "retry" || action === "refresh") {
    await loadData();
    return;
  }
  if (action === "cancel-shift-edit") {
    editingShiftId = null;
    errorMessage = "";
    render();
    return;
  }
  if (action === "cancel-shift-close") {
    closingShiftId = null;
    errorMessage = "";
    render();
    return;
  }
  if (action === "add-branch-shift") {
    document.querySelector("#pharmacy-form .branch-shift-rows").insertAdjacentHTML("beforeend", branchShiftTemplateRow());
    return;
  }
  if (action === "remove-branch-shift") {
    const row = event.target.closest(".branch-shift-row");
    if (document.querySelectorAll("#pharmacy-form .branch-shift-row").length > 1) row.remove();
    return;
  }
  const editShift = event.target.closest("[data-edit-shift]");
  if (editShift) {
    editingShiftId = Number(editShift.dataset.editShift);
    closingShiftId = null;
    errorMessage = "";
    render();
    return;
  }
  const closeShift = event.target.closest("[data-close-shift]");
  if (closeShift) {
    closingShiftId = Number(closeShift.dataset.closeShift);
    editingShiftId = null;
    errorMessage = "";
    render();
    return;
  }
  const deleteShift = event.target.closest("[data-delete-shift]");
  if (deleteShift) {
    if (!window.confirm("هل تريد حذف هذه الوردية؟")) return;
    try {
      await api(`/api/shifts/${deleteShift.dataset.deleteShift}`, { method: "DELETE" });
      await loadData();
    } catch (error) {
      errorMessage = error.message;
      render();
    }
    return;
  }
  const deletePharmacy = event.target.closest("[data-delete-pharmacy]");
  if (deletePharmacy) {
    if (!window.confirm("سيؤدي حذف الصيدلية إلى حذف جميع حركاتها. هل تريد المتابعة؟")) return;
    try {
      await api(`/api/pharmacies/${deletePharmacy.dataset.deletePharmacy}`, { method: "DELETE" });
      await loadData();
    } catch (error) {
      errorMessage = error.message;
      render();
    }
    return;
  }
  const deleteTransaction = event.target.closest("[data-delete-transaction]");
  if (deleteTransaction) {
    if (!window.confirm("هل تريد حذف هذه الحركة؟")) return;
    try {
      await api(`/api/transactions/${deleteTransaction.dataset.deleteTransaction}`, { method: "DELETE" });
      await loadData();
    } catch (error) {
      errorMessage = error.message;
      render();
    }
    return;
  }
  const deleteUser = event.target.closest("[data-delete-user]");
  if (deleteUser) {
    if (!window.confirm("هل تريد حذف حساب هذا المستخدم؟")) return;
    try {
      await api(`/api/users/${deleteUser.dataset.deleteUser}`, { method: "DELETE" });
      if (editingUserId === Number(deleteUser.dataset.deleteUser)) editingUserId = null;
      await loadData();
    } catch (error) {
      errorMessage = error.message;
      render();
    }
    return;
  }
  const editUser = event.target.closest("[data-edit-user]");
  if (editUser) {
    editingUserId = Number(editUser.dataset.editUser);
    errorMessage = "";
    render();
    document.querySelector("#edit-user-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "filter-form") {
    event.preventDefault();
    applyFilters(event.target);
  }
  if (event.target.id === "auth-form") {
    event.preventDefault();
    handleAuth(event.target);
  }
  if (event.target.id === "pharmacy-form") {
    event.preventDefault();
    submitPharmacyForm(event.target);
  }
  if (event.target.id === "transaction-form") {
    event.preventDefault();
    submitTransactionForm(event.target);
  }
  if (event.target.id === "user-form") {
    event.preventDefault();
    submitForm(event.target, "/api/users");
  }
  if (event.target.id === "edit-user-form") {
    event.preventDefault();
    const userId = Number(new FormData(event.target).get("userId"));
    submitForm(event.target, `/api/users/${userId}`, "PUT");
  }
  if (event.target.id === "shift-form") {
    event.preventDefault();
    submitShiftForm(event.target);
  }
  if (event.target.id === "shift-sales-form") {
    event.preventDefault();
    submitShiftSalesForm(event.target);
  }
});

document.addEventListener("change", (event) => {
  if (event.target.name === "role" && event.target.closest("#user-form, #edit-user-form")) {
    const form = event.target.closest("#user-form, #edit-user-form");
    const pharmacyField = form.querySelector('[name="pharmacyId"]');
    const adminRole = event.target.value === "admin";
    pharmacyField.required = !adminRole;
    pharmacyField.disabled = adminRole || !pharmacies.length;
    form.querySelector("[data-permissions-section]").hidden = adminRole;
    if (form.id === "user-form") {
      const manageShiftsField = form.querySelector('[name="permissions"][value="manage_shifts"]');
      manageShiftsField.checked = event.target.value === "branch_manager";
    }
  }
  if (event.target.name === "pharmacyId" && event.target.closest("#shift-form")) {
    const employeeField = document.querySelector('#shift-form [name="userId"]');
    const submitButton = document.querySelector('#shift-form [type="submit"]');
    const branchUsers = users.filter((user) => ["user", "branch_manager"].includes(user.role) && Number(user.pharmacyId) === Number(event.target.value));
    employeeField.innerHTML = `<option value="">${branchUsers.length ? "اختر المستخدم" : "لا يوجد مستخدمون مرتبطون بهذا الفرع"}</option>${branchUsers.map((user) => `<option value="${user.id}">${escapeHtml(user.displayName)}</option>`).join("")}`;
    employeeField.disabled = !branchUsers.length;
    submitButton.disabled = !branchUsers.length;
  }
  const transactionForm = event.target.closest("#transaction-form");
  if (transactionForm && event.target.name === "pharmacyId") {
    refreshSaleShifts(transactionForm);
  }
  if (transactionForm && event.target.name === "shiftTemplateId") {
    saleFormValues.shiftTemplateId = event.target.value;
  }
});

loadData();
