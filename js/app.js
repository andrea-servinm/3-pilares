// -----------------------------------------------------------
// 2. UTILIDADES DE FECHA Y ESTADO EN LOCALSTORAGE
// -----------------------------------------------------------
let STORAGE_KEY = 'mi_seguimiento_diario_v1';
let WATER_CAP_ML = 2500;
const WEEK_DAYS = [
  { value: 1, label: 'L' },
  { value: 2, label: 'M' },
  { value: 3, label: 'Mi' },
  { value: 4, label: 'J' },
  { value: 5, label: 'V' },
  { value: 6, label: 'S' },
  { value: 7, label: 'D' }
];

function getLocalDateKey(dateObj = new Date()) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isFutureDate(dateKey, todayKey = getLocalDateKey()) {
  return dateKey > todayKey;
}

function formatDisplayDate(dateObj = new Date()) {
  return dateObj.toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });
}

function formatHealthRecordDate(dateKey) {
  const [year, month, day] = dateKey.split('-');
  return year && month && day ? `${day}/${month}/${year}` : dateKey;
}

function formatActivityLoggedTime(timestamp) {
  if (!timestamp) return 'Hora no registrada';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? 'Hora no registrada'
    : date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function buildActivityHistory(activityLog, routines, history = [], seedTimes = new Map()) {
  const existingEntries = new Map();
  (Array.isArray(history) ? history : []).forEach(entry => {
    if (entry?.date && entry.routineId) {
      existingEntries.set(`${entry.date}\u0000${entry.routineId}`, entry);
    }
  });

  return Object.entries(activityLog || {}).flatMap(([date, routineIds]) => {
    const ids = Array.isArray(routineIds) ? routineIds : routineIds ? [routineIds] : [];
    return ids.map(routineId => {
      const existing = existingEntries.get(`${date}\u0000${routineId}`);
      const routine = routines.find(item => item.id === routineId);
      return {
        date,
        routineId,
        routineName: existing?.routineName || routine?.name || 'Rutina eliminada',
        loggedAt: existing?.loggedAt || seedTimes.get(`${date}\u0000${routineId}`) || null
      };
    });
  });
}

function getActivitySeedTimes(activity) {
  const seedTimes = new Map();
  (activity.completedDates || []).forEach(entry => {
    if (typeof entry !== 'object' || !entry.routineId || !entry.completedAt) return;
    seedTimes.set(`${entry.date}\u0000${entry.routineId}`, entry.completedAt);
  });
  return seedTimes;
}

// Carga un JSON desde /data
async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`No se pudo cargar ${path} (${res.status})`);
  return res.json();
}

// Construye el estado inicial a partir de los archivos JSON de /data
async function createInitialState(activityData) {
  const [water, routines, activity, health, reminders] = await Promise.all([
    fetchJSON('data/water.json'),
    fetchJSON('data/routines.json'),
    activityData ? Promise.resolve(activityData) : fetchJSON('data/activity.json'),
    fetchJSON('data/health-records.json'),
    fetchJSON('data/reminders.json')
  ]);

  const today = new Date();
  const todayKey = getLocalDateKey(today);

  const completedDates = [];
  const activityLog = {};
  const activityHistory = [];

  function logRoutine(date, routineId, completedAt) {
    if (!routineId) return;
    activityLog[date] = [...new Set([...(activityLog[date] || []), routineId])];
    const existing = activityHistory.find(entry => entry.date === date && entry.routineId === routineId);
    if (existing) {
      if (completedAt) existing.loggedAt = completedAt;
      return;
    }
    activityHistory.push({ date, routineId, loggedAt: completedAt || null });
  }

  // a) Relativos: "hace N días" (opcional)
  (activity.completedDaysAgo || []).forEach(entry => {
    const daysAgo = typeof entry === 'object' ? entry.daysAgo : entry;
    const routineId = typeof entry === 'object' ? entry.routineId : null;
    const completedAt = typeof entry === 'object' ? entry.completedAt : null;
    const prev = new Date(today);
    prev.setDate(today.getDate() - daysAgo);
    if (!activity.onlyCurrentMonth || prev.getMonth() === today.getMonth()) {
      const key = getLocalDateKey(prev);
      completedDates.push(key);
      logRoutine(key, routineId, completedAt);
    }
  });

  // b) Fechas fijas: "AAAA-MM-DD" o { date, routineId, completedAt }
  const currentMonthPrefix = todayKey.slice(0, 7);
  (activity.completedDates || []).forEach(entry => {
    const date = typeof entry === 'object' ? entry.date : entry;
    const routineId = typeof entry === 'object' ? entry.routineId : null;
    const completedAt = typeof entry === 'object' ? entry.completedAt : null;
    if (activity.onlyCurrentMonth && !date.startsWith(currentMonthPrefix)) return;
    if (!completedDates.includes(date)) completedDates.push(date);
    logRoutine(date, routineId, completedAt);
  });

  const healthRecords = health.records.map(({ monthsAgo, ...rec }) => {
    const d = new Date(today);
    d.setMonth(today.getMonth() - (monthsAgo || 0));
    return recalculateHealthRecord({ ...rec, date: getLocalDateKey(d) });
  });

  const savedRoutines = routines.routines.map(routine => ({
    ...routine,
    days: Array.isArray(routine.days) ? routine.days : []
  }));

  return {
    waterLogs: { [todayKey]: water.todayInitialMl },
    waterHistory: [],
    routines: savedRoutines,
    selectedRoutineId: routines.selectedRoutineId,
    completedActivityDates: completedDates,
    activityLog,
    activityHistory: buildActivityHistory(activityLog, savedRoutines, activityHistory),
    healthRecords,
    reminders
  };
}

async function loadState(activityData) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const initial = await createInitialState(activityData);
      saveState(initial);
      return initial;
    }
    const parsed = JSON.parse(raw);
    parsed.waterHistory = Array.isArray(parsed.waterHistory) ? parsed.waterHistory : [];
    parsed.healthRecords = (parsed.healthRecords || []).map(recalculateHealthRecord);
    parsed.activityLog = Object.fromEntries(
      Object.entries(parsed.activityLog || {}).map(([date, routineIds]) => [
        date,
        Array.isArray(routineIds) ? [...new Set(routineIds.filter(Boolean))] : routineIds ? [routineIds] : []
      ])
    );
    parsed.routines = parsed.routines.map(routine => ({
      ...routine,
      days: Array.isArray(routine.days) ? routine.days : []
    }));
    parsed.activityHistory = buildActivityHistory(
      parsed.activityLog,
      parsed.routines,
      parsed.activityHistory,
      getActivitySeedTimes(activityData)
    );
    return parsed;
  } catch (err) {
    console.error('Error cargando estado:', err);
    throw err;
  }
}

function saveState(newState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newState));
  } catch (err) {
    console.error('Error guardando en localStorage:', err);
  }
}

let appState = null;

// -----------------------------------------------------------
// 3. TOAST DE NOTIFICACIÓN VISUAL (SIN ALERT)
// -----------------------------------------------------------
let toastTimeout = null;
function showToast(message, type = 'success') {
  const banner = document.getElementById('toastBanner');
  const text = document.getElementById('toastText');
  const icon = document.getElementById('toastIcon');

  text.textContent = message;
  icon.textContent = type === 'warn' ? '!' : '✓';
  icon.className = type === 'warn' ? 'text-amber-400 font-bold' : 'text-brand-400 font-bold';

  banner.classList.remove('opacity-0', '-translate-y-2', 'pointer-events-none');
  banner.classList.add('opacity-100', 'translate-y-0');

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    banner.classList.remove('opacity-100', 'translate-y-0');
    banner.classList.add('opacity-0', '-translate-y-2', 'pointer-events-none');
  }, 2600);
}

// -----------------------------------------------------------
// 4. LÓGICA DE HIDRATACIÓN (TOPE 2500 ML)
// -----------------------------------------------------------
function getTodayWater() {
  const key = getLocalDateKey();
  return appState.waterLogs[key] || 0;
}

function recordWaterChange(dateKey, amountMl) {
  appState.waterHistory = Array.isArray(appState.waterHistory) ? appState.waterHistory : [];
  appState.waterHistory.push({
    date: dateKey,
    amountMl,
    loggedAt: new Date().toISOString()
  });
}

function addWater(deltaMl) {
  const key = getLocalDateKey();
  const current = getTodayWater();

  if (deltaMl > 0 && current >= WATER_CAP_ML) {
    showToast('¡Ya alcanzaste el tope diario de 2500 ml!', 'warn');
    return;
  }

  const updated = Math.max(0, Math.min(WATER_CAP_ML, current + deltaMl));
  const recordedChange = updated - current;
  if (recordedChange) recordWaterChange(key, recordedChange);
  appState.waterLogs[key] = updated;
  saveState(appState);
  renderAll();

  if (updated === WATER_CAP_ML && current < WATER_CAP_ML) {
    showToast('¡Meta diaria de 2500 ml completada! 💧');
  } else if (recordedChange > 0) {
    showToast(`+${recordedChange} ml registrados (${updated} / 2500 ml)`);
  } else if (recordedChange < 0) {
    showToast(`Ajuste de ${recordedChange} ml registrado (${updated} / 2500 ml)`);
  } else {
    showToast(`Ajustado a ${updated} ml`);
  }
}

function resetTodayWater() {
  const key = getLocalDateKey();
  appState.waterHistory = (appState.waterHistory || []).filter(entry => entry.date !== key);
  appState.waterLogs[key] = 0;
  saveState(appState);
  renderAll();
  showToast('Registro de agua de hoy reiniciado a 0 ml');
}

// -----------------------------------------------------------
// 5. LÓGICA DE SALUD MENSUAL (IMC, ICC, ICA Y RIESGO)
// -----------------------------------------------------------
function calculateBodyMetrics(sex, heightCm, weightKg, waistCm, hipCm) {
  const heightM = heightCm / 100;
  const imc = weightKg / (heightM * heightM);
  const icc = waistCm / hipCm;
  const ica = waistCm / heightCm;

  // Clasificación orientativa de IMC
  let imcCategory = 'Normal';
  if (imc < 18.5) imcCategory = 'Bajo peso';
  else if (imc >= 25 && imc < 30) imcCategory = 'Sobrepeso';
  else if (imc >= 30) imcCategory = 'Obesidad';

  const highIcc = sex === 'M' ? icc >= 1.0 : icc > 0.85;
  const highIca = ica >= 0.50;
  const veryHighIca = ica >= 0.60;
  const highImc = imc >= 30;
  const increasedRisk = imc >= 25 || highIca;

  let riskLevel = 'Bajo';
  let riskBadgeClass = 'bg-emerald-100 text-emerald-800';

  if (highImc || highIcc || veryHighIca) {
    riskLevel = 'Alto';
    riskBadgeClass = 'bg-rose-100 text-rose-800';
  } else if (increasedRisk) {
    riskLevel = 'Aumentado';
    riskBadgeClass = 'bg-amber-100 text-amber-800';
  }

  return {
    imc: Number(imc.toFixed(1)),
    icc: Number(icc.toFixed(2)),
    ica: Number(ica.toFixed(2)),
    imcCategory,
    iccStatus: highIcc ? 'Alto' : 'Óptimo',
    icaStatus: veryHighIca ? 'Alto' : highIca ? 'Riesgo aumentado' : 'Óptimo',
    riskLevel,
    riskBadgeClass
  };
}

function recalculateHealthRecord(record) {
  const measurements = [record.height, record.weight, record.waist, record.hip];
  if (!['M', 'F'].includes(record.sex) ||
    !measurements.every(value => Number.isFinite(value) && value > 0)) {
    return record;
  }

  return {
    ...record,
    ...calculateBodyMetrics(record.sex, record.height, record.weight, record.waist, record.hip)
  };
}

const healthMetricsModal = document.getElementById('healthMetricsModal');
document.getElementById('openHealthMetricsModalBtn').addEventListener('click', () => {
  healthMetricsModal.showModal();
});
document.getElementById('closeHealthMetricsModalBtn').addEventListener('click', () => {
  healthMetricsModal.close();
});

document.getElementById('healthMetricsForm').addEventListener('submit', function (e) {
  e.preventDefault();
  const sex = document.querySelector('input[name="bioSex"]:checked').value;
  const height = parseFloat(document.getElementById('inputHeight').value);
  const weight = parseFloat(document.getElementById('inputWeight').value);
  const waist = parseFloat(document.getElementById('inputWaist').value);
  const hip = parseFloat(document.getElementById('inputHip').value);

  if (!height || !weight || !waist || !hip) return;

  const metrics = calculateBodyMetrics(sex, height, weight, waist, hip);
  const record = {
    id: 'hr-' + Date.now(),
    date: getLocalDateKey(),
    sex,
    height,
    weight,
    waist,
    hip,
    ...metrics
  };

  appState.healthRecords.unshift(record);
  saveState(appState);
  renderAll();
  healthMetricsModal.close();
  showToast('Chequeo mensual calculado y guardado');
});

function deleteHealthRecord(id) {
  appState.healthRecords = appState.healthRecords.filter(r => r.id !== id);
  saveState(appState);
  renderAll();
  showToast('Registro eliminado');
}

// -----------------------------------------------------------
// 6. LÓGICA DE ACTIVIDAD, RUTINAS Y RACHAS (SEMANAL Y MENSUAL)
// -----------------------------------------------------------
function isTodayActivityDone() {
  const todayKey = getLocalDateKey();
  return appState.completedActivityDates.includes(todayKey);
}

function getCompletedRoutineIds(dateKey) {
  const routineIds = (appState.activityLog || {})[dateKey];
  return Array.isArray(routineIds) ? routineIds : routineIds ? [routineIds] : [];
}

function getCompletedRoutineCount(dateKey) {
  const routineCount = getCompletedRoutineIds(dateKey).length;
  return routineCount || (appState.completedActivityDates.includes(dateKey) ? 1 : 0);
}

function recordRoutineCompletion(dateKey, routine) {
  appState.activityHistory = (appState.activityHistory || []).filter(entry =>
    entry.date !== dateKey || entry.routineId !== routine.id
  );
  appState.activityHistory.push({
    date: dateKey,
    routineId: routine.id,
    routineName: routine.name,
    loggedAt: new Date().toISOString()
  });
}

function removeRoutineCompletionFromHistory(dateKey, routineId) {
  appState.activityHistory = (appState.activityHistory || []).filter(entry =>
    entry.date !== dateKey || entry.routineId !== routineId
  );
}

function toggleRoutineActivity(routineId, dateKey = getLocalDateKey()) {
  if (isFutureDate(dateKey)) {
    showToast('No puedes registrar actividad en una fecha futura.', 'warn');
    return;
  }

  const routine = appState.routines.find(item => item.id === routineId);
  if (!routine) return;

  appState.activityLog = appState.activityLog || {};
  const completedRoutineIds = getCompletedRoutineIds(dateKey);

  if (completedRoutineIds.includes(routineId)) {
    const remainingRoutineIds = completedRoutineIds.filter(id => id !== routineId);
    if (remainingRoutineIds.length) {
      appState.activityLog[dateKey] = remainingRoutineIds;
    } else {
      delete appState.activityLog[dateKey];
      appState.completedActivityDates = appState.completedActivityDates.filter(date => date !== dateKey);
    }
    removeRoutineCompletionFromHistory(dateKey, routineId);
    showToast(dateKey === getLocalDateKey() ? 'Rutina de hoy desmarcada' : 'Rutina del día desmarcada');
  } else {
    appState.activityLog[dateKey] = [...completedRoutineIds, routineId];
    if (!appState.completedActivityDates.includes(dateKey)) {
      appState.completedActivityDates.push(dateKey);
    }
    recordRoutineCompletion(dateKey, routine);
    showToast(`¡Rutina completada! ${appState.activityLog[dateKey].length} en total`);
  }

  saveState(appState);
  renderAll();
}

// Calcula días cumplidos en la semana actual (Lunes a Domingo)
function getWeeklyStreakCount() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 Dom, 1 Lun ... 6 Sab
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const monday = new Date(now);
  monday.setDate(now.getDate() - diffToMonday);
  monday.setHours(0, 0, 0, 0);

  let count = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const key = getLocalDateKey(d);
    if (appState.completedActivityDates.includes(key)) {
      count++;
    }
  }
  return count;
}

// Convierte "AAAA-MM-DD" en Date local
function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isRoutineScheduledOnDate(date) {
  const day = date.getDay() || 7;
  return appState.routines.some(routine => routine.days.includes(day));
}

// Los días sin rutina programada son descanso; un día programado sin completar corta la racha.
function getCurrentStreak() {
  const dates = new Set(appState.completedActivityDates);
  if (dates.size === 0) return 0;

  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  if (!dates.has(getLocalDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  const firstLoggedDate = parseDateKey([...dates].sort()[0]);
  let count = 0;
  while (cursor >= firstLoggedDate) {
    if (dates.has(getLocalDateKey(cursor))) {
      count++;
    } else if (isRoutineScheduledOnDate(cursor)) {
      break;
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

// Mejor racha histórica, ignorando los días de descanso y cortando en rutinas programadas omitidas.
function getBestStreak() {
  const completedDates = [...new Set(appState.completedActivityDates)].sort();
  if (completedDates.length === 0) return 0;

  const completedDateSet = new Set(completedDates);
  const cursor = parseDateKey(completedDates[0]);
  const lastLoggedDate = parseDateKey(completedDates[completedDates.length - 1]);
  let best = 0;
  let run = 0;

  while (cursor <= lastLoggedDate) {
    if (completedDateSet.has(getLocalDateKey(cursor))) {
      run++;
      best = Math.max(best, run);
    } else if (isRoutineScheduledOnDate(cursor)) {
      run = 0;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return best;
}

// Fila de la semana actual: L M X J V S D
function renderWeekRow() {
  const el = document.getElementById('weekRow');
  if (!el) return;
  const now = new Date();
  const diffToMonday = now.getDay() === 0 ? 6 : now.getDay() - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diffToMonday);
  monday.setHours(0, 0, 0, 0);
  const todayKey = getLocalDateKey(now);
  const labels = ['L', 'M', 'Mi', 'J', 'V', 'S', 'D'];

  el.innerHTML = labels.map((label, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const key = getLocalDateKey(d);
    const count = getCompletedRoutineCount(key);
    const isToday = key === todayKey;
    const isSelected = key === selectedCalendarDate;
    let cls = 'relative min-w-0 min-h-[44px] flex-1 rounded-xl flex items-center justify-center text-xs font-bold border transition ';
    if (count) cls += 'bg-brand-600 text-white border-brand-600';
    else if (isToday) cls += 'bg-white text-brand-700 border-2 border-brand-500';
    else cls += 'bg-white text-slate-500 border-slate-200';
    if (isSelected) cls += ' ring-2 ring-brand-300 ring-offset-1';
    const countLabel = `${count} ${count === 1 ? 'rutina completada' : 'rutinas completadas'}`;
    const accessibleLabel = `${formatDisplayDate(d)}${count ? `, ${countLabel}` : ''}`;
    return `<button type="button" class="${cls}" data-calendar-date="${key}" aria-pressed="${isSelected}" aria-label="${accessibleLabel}" title="${accessibleLabel}"><span>${label}</span>${count > 1
      ? `<span class="absolute -top-1 -right-1 z-10 min-w-4 h-4 px-1 rounded-full bg-brand-100 text-brand-800 border border-brand-200 text-[9px] leading-none flex items-center justify-center">${count}</span>`
      : ''}</button>`;
  }).join('');
}

// Calcula días cumplidos en el mes calendario actual
function getMonthlyStreakCount() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `${year}-${month}-`;

  return appState.completedActivityDates.filter(d => d.startsWith(prefix)).length;
}

// Selector de vista del calendario: 'week' (por defecto) o 'month'
let calendarView = 'week';
let selectedCalendarDate = getLocalDateKey();

function handleCalendarDateClick(event) {
  const button = event.target.closest('button[data-calendar-date]');
  if (!button) return;
  if (routineEntryDate && routineEntryDate !== button.dataset.calendarDate) {
    newRoutineForm.reset();
  }
  selectedCalendarDate = button.dataset.calendarDate;
  renderAll();
}

document.getElementById('weekRow').addEventListener('click', handleCalendarDateClick);
document.getElementById('miniCalendarGrid').addEventListener('click', handleCalendarDateClick);

function setCalendarView(view) {
  calendarView = view;
  document.getElementById('calWeekView').classList.toggle('hidden', view !== 'week');
  document.getElementById('calMonthView').classList.toggle('hidden', view !== 'month');
  document.querySelectorAll('[data-cal-view]').forEach(btn => {
    const active = btn.dataset.calView === view;
    btn.classList.toggle('bg-white', active);
    btn.classList.toggle('text-brand-700', active);
    btn.classList.toggle('shadow-sm', active);
    btn.classList.toggle('text-slate-500', !active);
  });
}

document.querySelectorAll('[data-cal-view]').forEach(btn => {
  btn.addEventListener('click', () => setCalendarView(btn.dataset.calView));
});
setCalendarView('week');

// Formulario Nueva Rutina
const newRoutineForm = document.getElementById('newRoutineForm');
const newRoutineModal = document.getElementById('newRoutineModal');
const routineDaysFieldset = document.getElementById('routineDaysFieldset');
const routineEntryDateTitle = document.getElementById('newRoutineTitle');
const routineFormInlineTitle = document.getElementById('routineFormInlineTitle');
const routineFormInlineContainer = document.getElementById('routineFormInlineContainer');
const routineFormModalContainer = document.getElementById('routineFormModalContainer');
const saveRoutineBtn = document.getElementById('saveRoutineBtn');
const cancelNewRoutineBtn = document.getElementById('cancelNewRoutineBtn');
let routineEntryDate = null;
let editingRoutineId = null;

function configureRoutineForm(isInline, dateKey = null) {
  if (isInline) editingRoutineId = null;
  routineEntryDate = isInline ? dateKey : null;
  routineDaysFieldset.classList.toggle('hidden', isInline);
  routineFormInlineTitle.classList.toggle('hidden', !isInline);
  routineEntryDateTitle.textContent = editingRoutineId ? 'Editar Rutina' : 'Agregar Nueva Rutina';
  saveRoutineBtn.textContent = isInline
    ? 'Registrar entrenamiento'
    : editingRoutineId ? 'Guardar cambios' : 'Guardar Rutina';
  cancelNewRoutineBtn.textContent = isInline ? 'Limpiar' : 'Cancelar';
  const container = isInline ? routineFormInlineContainer : routineFormModalContainer;
  if (newRoutineForm.parentElement !== container) container.append(newRoutineForm);
}

function openNewRoutineModal() {
  editingRoutineId = null;
  newRoutineForm.reset();
  configureRoutineForm(false);
  newRoutineModal.showModal();
}

function openEditRoutineModal(id) {
  const routine = appState.routines.find(item => item.id === id);
  if (!routine) return;

  editingRoutineId = id;
  configureRoutineForm(false);
  document.getElementById('routineNameInput').value = routine.name;
  document.getElementById('routineWarmupInput').value = routine.warmup;
  document.getElementById('routineMainInput').value = routine.main;
  document.getElementById('routineCooldownInput').value = routine.cooldown;
  const routineDays = new Set(routine.days || []);
  newRoutineForm.querySelectorAll('input[name="routineDays"]').forEach(input => {
    input.checked = routineDays.has(Number(input.value));
  });
  newRoutineModal.showModal();
}

document.getElementById('toggleNewRoutineFormBtn').addEventListener('click', () => openNewRoutineModal());
const closeNewRoutineModal = () => {
  newRoutineModal.close();
};
document.getElementById('closeNewRoutineModalBtn').addEventListener('click', closeNewRoutineModal);
cancelNewRoutineBtn.addEventListener('click', () => {
  if (routineEntryDate) {
    newRoutineForm.reset();
    return;
  }
  closeNewRoutineModal();
});
newRoutineModal.addEventListener('close', () => {
  newRoutineForm.reset();
  routineEntryDate = null;
  editingRoutineId = null;
  if (appState) renderAll();
});

newRoutineForm.addEventListener('submit', function (e) {
  e.preventDefault();
  if (routineEntryDate && isFutureDate(routineEntryDate)) {
    showToast('No puedes registrar actividad en una fecha futura.', 'warn');
    return;
  }

  const name = document.getElementById('routineNameInput').value.trim();
  const warmup = document.getElementById('routineWarmupInput').value.trim();
  const main = document.getElementById('routineMainInput').value.trim();
  const cooldown = document.getElementById('routineCooldownInput').value.trim();
  const entryDate = routineEntryDate;
  const days = [...newRoutineForm.querySelectorAll('input[name="routineDays"]:checked')]
    .map(input => Number(input.value));

  if (!name || !warmup || !main || !cooldown) return;

  if (editingRoutineId) {
    const routine = appState.routines.find(item => item.id === editingRoutineId);
    if (!routine) {
      showToast('No se encontró la rutina que quieres editar.', 'warn');
      return;
    }

    Object.assign(routine, { name, warmup, main, cooldown, days });
    saveState(appState);
    newRoutineModal.close();
    showToast('Rutina actualizada');
    return;
  }

  const newRut = {
    id: 'rut-' + Date.now(),
    name,
    warmup,
    main,
    cooldown,
    days: entryDate ? [] : days,
    ...(entryDate ? { date: entryDate } : {})
  };

  appState.routines.push(newRut);
  if (entryDate) {
    appState.activityLog = appState.activityLog || {};
    appState.activityLog[entryDate] = [...new Set([...getCompletedRoutineIds(entryDate), newRut.id])];
    if (!appState.completedActivityDates.includes(entryDate)) {
      appState.completedActivityDates.push(entryDate);
    }
    recordRoutineCompletion(entryDate, newRut);
  } else {
    appState.selectedRoutineId = newRut.id;
  }
  saveState(appState);

  if (entryDate) newRoutineForm.reset();
  else newRoutineModal.close();
  renderAll();
  showToast(entryDate ? 'Entrenamiento registrado para ese día' : 'Nueva rutina agregada y seleccionada');
});

function toggleRoutineDay(id, day) {
  const routine = appState.routines.find(item => item.id === id);
  if (!routine) return;

  routine.days = Array.isArray(routine.days) ? routine.days : [];
  routine.days = routine.days.includes(day)
    ? routine.days.filter(scheduledDay => scheduledDay !== day)
    : [...routine.days, day].sort((a, b) => a - b);
  saveState(appState);
  renderAll();
}

function deleteRoutine(id) {
  if (appState.routines.length <= 1) {
    showToast('Debes mantener al menos 1 rutina disponible', 'warn');
    return;
  }
  appState.routines = appState.routines.filter(r => r.id !== id);
  if (appState.selectedRoutineId === id) {
    appState.selectedRoutineId = appState.routines[0].id;
  }
  saveState(appState);
  renderAll();
  showToast('Rutina eliminada');
}

// -----------------------------------------------------------
// 7. NOTIFICACIONES WEB Y GENERADOR DE ARCHIVO .ICS
// -----------------------------------------------------------
const notifModal = document.getElementById('notificationsModal');
document.getElementById('openNotificationsBtn').addEventListener('click', () => {
  updateNotificationStatusUI();
  document.getElementById('waterStartTime').value = appState.reminders.waterStart || '09:00';
  document.getElementById('activityTime').value = appState.reminders.activityTime || '18:30';
  notifModal.classList.remove('hidden');
});
document.getElementById('closeNotificationsBtn').addEventListener('click', () => {
  notifModal.classList.add('hidden');
});
notifModal.addEventListener('click', (e) => {
  if (e.target === notifModal) notifModal.classList.add('hidden');
});

function updateNotificationStatusUI() {
  const badge = document.getElementById('browserPermBadge');
  const dot = document.getElementById('notifStatusDot');

  if (!('Notification' in window)) {
    badge.textContent = 'No soportado';
    badge.className = 'px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-200 text-slate-700';
    return;
  }

  if (Notification.permission === 'granted') {
    badge.textContent = 'Activas';
    badge.className = 'px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800';
    dot.className = 'w-2 h-2 rounded-full bg-emerald-500';
  } else if (Notification.permission === 'denied') {
    badge.textContent = 'Bloqueadas';
    badge.className = 'px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-100 text-rose-800';
    dot.className = 'w-2 h-2 rounded-full bg-rose-500';
  } else {
    badge.textContent = 'Pendiente';
    badge.className = 'px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800';
    dot.className = 'w-2 h-2 rounded-full bg-amber-400';
  }
}

document.getElementById('requestNotifPermBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) {
    showToast('Este navegador no soporta Notification API. Usa el archivo .ics', 'warn');
    return;
  }
  const perm = await Notification.requestPermission();
  updateNotificationStatusUI();
  if (perm === 'granted') {
    showToast('¡Notificaciones activadas!');
  } else {
    showToast('Permiso no concedido. Puedes usar los recordatorios .ics', 'warn');
  }
});

document.getElementById('testNotifBtn').addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('3-Pilares 💧', {
      body: `Llevas ${getTodayWater()} / 2500 ml de agua hoy. ¡Sigue así!`
    });
    showToast('Notificación enviada al sistema');
  } else {
    showToast('Primero activa el permiso o descarga el calendario .ics', 'warn');
  }
});

document.getElementById('saveReminderPrefsBtn').addEventListener('click', () => {
  appState.reminders.waterStart = document.getElementById('waterStartTime').value || '09:00';
  appState.reminders.activityTime = document.getElementById('activityTime').value || '18:30';
  saveState(appState);
  showToast('Horarios de recordatorio guardados');
});

// Genera un archivo .ICS real con eventos recurrentes diarios y mensuales
document.getElementById('downloadIcsBtn').addEventListener('click', () => {
  const waterStart = document.getElementById('waterStartTime').value || '09:00';
  const activityTime = document.getElementById('activityTime').value || '18:30';

  const [wHour, wMin] = waterStart.split(':').map(Number);
  const [aHour, aMin] = activityTime.split(':').map(Number);

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

  function formatIcsTime(h, m) {
    return `${dateStamp}T${pad(h % 24)}${pad(m)}00`;
  }

  // 4 bloques de hidratación cada 3 horas a partir de la hora de inicio
  const waterOffsets = [0, 3, 6, 9];
  let waterEvents = '';
  waterOffsets.forEach((offset, idx) => {
    const startStr = formatIcsTime(wHour + offset, wMin);
    const endStr = formatIcsTime(wHour + offset, (wMin + 15) % 60);
    waterEvents += `BEGIN:VEVENT
UID:agua-bloque-${idx + 1}-${Date.now()}@miseguimientodiario.app
DTSTAMP:${dateStamp}T080000Z
DTSTART:${startStr}
DTEND:${endStr}
SUMMARY:💧 Hidratación (${(idx + 1) * 500} / 2500 ml)
DESCRIPTION:Toma un vaso o botella de agua y regístralo en 3-Pilares (tope 2500 ml).
RRULE:FREQ=DAILY
BEGIN:VALARM
TRIGGER:-PT0M
ACTION:DISPLAY
DESCRIPTION:Hora de tomar agua
END:VALARM
END:VEVENT
`;
  });

  const actStart = formatIcsTime(aHour, aMin);
  const actEnd = formatIcsTime(aHour, (aMin + 30) % 60);

  // Primer día del próximo mes a las 08:30 para chequeo mensual
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const monthlyStamp = `${nextMonth.getFullYear()}${pad(nextMonth.getMonth() + 1)}01`;

  const icsContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//3-Pilares//PWA Tracker//ES
CALSCALE:GREGORIAN
METHOD:PUBLISH
${waterEvents}BEGIN:VEVENT
UID:actividad-diaria-${Date.now()}@miseguimientodiario.app
DTSTAMP:${dateStamp}T080000Z
DTSTART:${actStart}
DTEND:${actEnd}
SUMMARY:🔥 Rutina Física del Día
DESCRIPTION:Completa tu calentamiento, bloque principal y enfriamiento, y marca tu racha en la app.
RRULE:FREQ=DAILY
BEGIN:VALARM
TRIGGER:-PT0M
ACTION:DISPLAY
DESCRIPTION:Momento de tu rutina física diaria
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:chequeo-mensual-${Date.now()}@miseguimientodiario.app
DTSTAMP:${dateStamp}T080000Z
DTSTART:${monthlyStamp}T083000
DTEND:${monthlyStamp}T084500
SUMMARY:📏 Chequeo Mensual de Salud (IMC, ICC, ICA)
DESCRIPTION:Registra altura, peso, cintura y cadera en 3-Pilares para evaluar tu evolución mensual.
RRULE:FREQ=MONTHLY;BYMONTHDAY=1
BEGIN:VALARM
TRIGGER:-PT0M
ACTION:DISPLAY
DESCRIPTION:Chequeo mensual de medidas corporales
END:VALARM
END:VEVENT
END:VCALENDAR`;

  const blob = new Blob([icsContent.replace(/\n/g, '\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'recordatorios-seguimiento-diario.ics';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('Archivo .ics descargado. Ábrelo para añadir a tu calendario');
});

// -----------------------------------------------------------
// 8. NAVEGACIÓN ENTRE PESTAÑAS
// -----------------------------------------------------------
const navButtons = document.querySelectorAll('.nav-btn');
const tabSections = {
  resumen: document.getElementById('tab-resumen'),
  salud: document.getElementById('tab-salud'),
  actividad: document.getElementById('tab-actividad'),
  finanzas: document.getElementById('tab-finanzas')
};

function switchTab(tabName) {
  Object.entries(tabSections).forEach(([key, section]) => {
    if (key === tabName) {
      section.classList.remove('hidden');
    } else {
      section.classList.add('hidden');
    }
  });

  navButtons.forEach(btn => {
    const isTarget = btn.dataset.tab === tabName;
    const isDesktopNav = btn.closest('header nav') !== null;

    if (isDesktopNav) {
      if (isTarget) {
        btn.className = 'nav-btn px-4 py-2 rounded-xl text-xs font-bold text-brand-700 bg-white shadow-xs transition';
      } else {
        btn.className = 'nav-btn px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:text-slate-900 transition';
      }
    } else {
      if (isTarget) {
        btn.className = 'nav-btn flex-1 min-h-[44px] flex flex-col items-center justify-center py-1.5 rounded-2xl text-brand-600 font-bold bg-brand-50/70 transition';
      } else {
        btn.className = 'nav-btn flex-1 min-h-[44px] flex flex-col items-center justify-center py-1.5 rounded-2xl text-slate-400 font-medium transition';
      }
    }
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

navButtons.forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// -----------------------------------------------------------
// 9. RENDERIZADO COMPLETO DE LA INTERFAZ
// -----------------------------------------------------------
function renderAll() {
  const now = new Date();
  document.getElementById('headerDateLabel').textContent = formatDisplayDate(now);

  const waterToday = getTodayWater();
  const waterPct = Math.min(100, Math.round((waterToday / WATER_CAP_ML) * 100));
  const activityDone = isTodayActivityDone();
  const weeklyStreak = getWeeklyStreakCount();
  const monthlyStreak = getMonthlyStreakCount();
  const currentStreak = getCurrentStreak();
  const todayDay = now.getDay() || 7;
  const savedRoutines = appState.routines.filter(routine => !routine.date);
  const scheduledToday = savedRoutines.filter(routine => routine.days.includes(todayDay));
  const storedSelection = savedRoutines.find(r => r.id === appState.selectedRoutineId);
  const selectedRoutine = scheduledToday.length
    ? scheduledToday.find(routine => routine.id === storedSelection?.id) || scheduledToday[0]
    : storedSelection || savedRoutines[0];
  if (selectedRoutine && appState.selectedRoutineId !== selectedRoutine.id) {
    appState.selectedRoutineId = selectedRoutine.id;
    saveState(appState);
  }
  const completedRoutineIdsToday = getCompletedRoutineIds(getLocalDateKey(now));
  const completedTodayCount = getCompletedRoutineCount(getLocalDateKey(now));
  const latestHealth = appState.healthRecords[0] || null;

  // --- RENDER PESTAÑA RESUMEN ---
  const dailyScore = Math.round((waterPct * 0.5) + (activityDone ? 50 : 0));
  document.getElementById('heroWaterPercent').textContent = `${waterPct}%`;
  document.getElementById('heroWaterText').textContent = `${waterToday} / ${WATER_CAP_ML} ml`;
  document.getElementById('heroActivityText').textContent = activityDone ? 'Completada ✓' : 'Pendiente';
  document.getElementById('heroCurrentStreak').textContent = currentStreak;

  if (dailyScore === 100) {
    document.getElementById('summaryMotivation').textContent = '¡Objetivo del día 100% cumplido! Excelente constancia.';
  } else if (dailyScore >= 50) {
    document.getElementById('summaryMotivation').textContent = '¡Vas por muy buen camino hoy! Sigue sumando.';
  } else {
    document.getElementById('summaryMotivation').textContent = 'Cada vaso de agua y cada sesión cuentan.';
  }

  document.getElementById('summaryWaterFraction').textContent = `${waterToday} / ${WATER_CAP_ML} ml`;
  document.getElementById('summaryWaterBar').style.width = `${waterPct}%`;
  const remaining = Math.max(0, WATER_CAP_ML - waterToday);
  document.getElementById('summaryWaterRemaining').textContent = remaining === 0
    ? '¡Meta diaria alcanzada!'
    : `Faltan ${remaining} ml para el tope`;

  document.getElementById('summaryRoutineName').textContent = 'Rutinas realizadas';
  const badgeEl = document.getElementById('summaryActivityBadge');

  const activityTotalToday = Math.max(scheduledToday.length, completedTodayCount);
  badgeEl.textContent = `${completedTodayCount}/${activityTotalToday}`;
  if (scheduledToday.length > 1 && completedTodayCount > 0) {
    badgeEl.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800';
  } else if (scheduledToday.length > 1) {
    badgeEl.className = 'px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-100 text-rose-800';
  } else if (completedTodayCount > 0 && completedTodayCount >= activityTotalToday) {
    badgeEl.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800';
  } else if (scheduledToday.length > 0) {
    badgeEl.className = 'px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800';
  } else {
    badgeEl.className = 'px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-600';
  }

  document.getElementById('summaryCurrentStreak').textContent = currentStreak;
  document.getElementById('summaryWeeklyStreak').textContent = weeklyStreak;

  const heroHealthRiskBadge = document.getElementById('heroHealthRiskBadge');
  if (latestHealth) {
    heroHealthRiskBadge.textContent = latestHealth.riskLevel;
    heroHealthRiskBadge.className =
      `shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${latestHealth.riskBadgeClass}`;
    document.getElementById('summaryLastCheckDate').textContent =
      `Registrado el ${formatHealthRecordDate(latestHealth.date)}`;
    const riskBadge = document.getElementById('summaryRiskBadge');
    riskBadge.textContent = latestHealth.riskLevel;
    riskBadge.className = `px-2.5 py-1 rounded-full text-xs font-bold ${latestHealth.riskBadgeClass}`;

    document.getElementById('summaryImcVal').textContent = latestHealth.imc;
    document.getElementById('summaryImcCat').textContent = latestHealth.imcCategory;
    document.getElementById('summaryIccVal').textContent = latestHealth.icc;
    document.getElementById('summaryIcaVal').textContent = latestHealth.ica;
  } else {
    heroHealthRiskBadge.textContent = 'Sin datos';
    heroHealthRiskBadge.className = 'shrink-0 rounded-full bg-white/20 px-2.5 py-1 text-xs font-bold';
    document.getElementById('summaryLastCheckDate').textContent = 'Sin registros aún';
    document.getElementById('summaryRiskBadge').textContent = 'Sin datos';
    document.getElementById('summaryImcVal').textContent = '--';
    document.getElementById('summaryIccVal').textContent = '--';
    document.getElementById('summaryIcaVal').textContent = '--';
  }

  // --- RENDER PESTAÑA SALUD ---
  document.getElementById('waterCurrentDisplay').textContent = `${waterToday} ml`;
  document.getElementById('waterPercentDisplay').textContent = `${waterPct}% completado`;
  const circumference = 314.16;
  const offset = circumference - (waterPct / 100) * circumference;
  document.getElementById('waterRingProgress').style.strokeDashoffset = offset;
  renderWaterHistory();

  if (latestHealth) {
    document.getElementById('latestHealthResultCard').classList.remove('hidden');
    const hTag = document.getElementById('healthRiskTag');
    hTag.textContent = latestHealth.riskLevel;
    hTag.className = `px-2.5 py-0.5 rounded-full text-xs font-bold ${latestHealth.riskBadgeClass}`;

    const imcColorClass = latestHealth.imcCategory === 'Normal' ? 'text-emerald-700' : 'text-rose-700';
    const iccColorClass = latestHealth.iccStatus === 'Óptimo' ? 'text-emerald-700' : 'text-rose-700';
    const icaColorClass = latestHealth.icaStatus === 'Óptimo' ? 'text-emerald-700' : 'text-rose-700';

    document.getElementById('resImc').className = `text-base font-extrabold ${imcColorClass}`;
    document.getElementById('resImc').textContent = latestHealth.imc;
    document.getElementById('resImcLabel').className = `text-[10px] ${imcColorClass}`;
    document.getElementById('resImcLabel').textContent = latestHealth.imcCategory;
    document.getElementById('resIcc').className = `text-base font-extrabold ${iccColorClass}`;
    document.getElementById('resIcc').textContent = latestHealth.icc;
    document.getElementById('resIccLabel').className = `text-[10px] ${iccColorClass}`;
    document.getElementById('resIccLabel').textContent = latestHealth.iccStatus;
    document.getElementById('resIca').className = `text-base font-extrabold ${icaColorClass}`;
    document.getElementById('resIca').textContent = latestHealth.ica;
    document.getElementById('resIcaLabel').className = `text-[10px] ${icaColorClass}`;
    document.getElementById('resIcaLabel').textContent = latestHealth.icaStatus;
    // Prellenar altura si el formulario está vacío para comodidad
    const hInput = document.getElementById('inputHeight');
    if (!hInput.value) hInput.value = latestHealth.height;
  } else {
    document.getElementById('latestHealthResultCard').classList.add('hidden');
  }

  const historyContainer = document.getElementById('healthHistoryList');
  if (appState.healthRecords.length === 0) {
    historyContainer.innerHTML = `<p class="text-xs text-slate-400 text-center py-3">Aún no hay mediciones mensuales registradas.</p>`;
  } else {
    const records = [...appState.healthRecords].sort((a, b) => b.date.localeCompare(a.date));
    const renderHealthRecords = items => items.map(rec => `
          <div class="p-3 rounded-2xl bg-slate-50 border border-slate-200/70 flex items-center justify-between gap-2">
            <div>
              <div class="flex items-center gap-2">
                <span class="text-xs font-bold text-slate-800">${formatHealthRecordDate(rec.date)}</span>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${rec.riskBadgeClass}">${rec.riskLevel}</span>
              </div>
              <div class="text-[11px] text-slate-500 mt-1">
                Peso: <strong>${rec.weight}kg</strong> · IMC: <strong>${rec.imc}</strong> · ICC: <strong>${rec.icc}</strong> · ICA: <strong>${rec.ica}</strong>
              </div>
            </div>
            <button type="button" onclick="deleteHealthRecord('${rec.id}')" title="Eliminar"
              class="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition text-xs font-bold">
              ✕
            </button>
          </div>
        `).join('');
    const recentRecords = records.slice(0, 3);
    const olderRecords = records.slice(3);

    historyContainer.innerHTML = `
      ${renderHealthRecords(recentRecords)}
      ${olderRecords.length ? `
        <details class="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <summary class="cursor-pointer text-xs font-semibold text-brand-700">
            Ver más (${olderRecords.length} ${olderRecords.length === 1 ? 'medición' : 'mediciones'})
          </summary>
          <div class="mt-2.5 space-y-2.5">${renderHealthRecords(olderRecords)}</div>
        </details>
      ` : ''}
    `;
  }

  // --- RENDER PESTAÑA ACTIVIDAD ---
  document.getElementById('actWeeklyCount').textContent = weeklyStreak;
  document.getElementById('actMonthlyCount').textContent = monthlyStreak;
  document.getElementById('actStreakCurrent').textContent = currentStreak;
  document.getElementById('actStreakRecord').textContent = getBestStreak();
  renderWeekRow();
  document.getElementById('calendarMonthTitle').textContent = now.toLocaleDateString('es-ES', { month: 'short', year: 'numeric' });

  // Mini calendario del mes
  const calGrid = document.getElementById('miniCalendarGrid');
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstDayOfMonth = new Date(year, month, 1).getDay(); // 0 Dom .. 6 Sab
  const startOffset = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;
  const totalDays = new Date(year, month + 1, 0).getDate();
  const todayDateNum = now.getDate();

  let calHtml = '';
  for (let empty = 0; empty < startOffset; empty++) {
    calHtml += `<div class="h-8"></div>`;
  }
  for (let d = 1; d <= totalDays; d++) {
    const dKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const count = getCompletedRoutineCount(dKey);
    const isToday = d === todayDateNum;
    const isSelected = dKey === selectedCalendarDate;
    const dayDate = parseDateKey(dKey);

    let cellClass = 'relative w-full min-h-[44px] rounded-lg flex items-center justify-center text-xs font-semibold transition ';
    if (count) {
      cellClass += 'bg-brand-600 text-white font-bold shadow-xs';
    } else if (isToday) {
      cellClass += 'bg-brand-50 text-brand-700 border-2 border-brand-500 font-bold';
    } else {
      cellClass += 'bg-slate-50 text-slate-600';
    }
    if (isSelected) cellClass += ' ring-2 ring-brand-300 ring-offset-1';
    const countLabel = `${count} ${count === 1 ? 'rutina completada' : 'rutinas completadas'}`;
    const accessibleLabel = `${formatDisplayDate(dayDate)}${count ? `, ${countLabel}` : ''}`;
    calHtml += `<button type="button" class="${cellClass}" data-calendar-date="${dKey}" aria-pressed="${isSelected}" aria-label="${accessibleLabel}" title="${accessibleLabel}"><span>${d}</span>${count > 1
      ? `<span class="absolute -top-1 -right-1 z-10 min-w-4 h-4 px-1 rounded-full bg-brand-100 text-brand-800 border border-brand-200 text-[9px] leading-none flex items-center justify-center">${count}</span>`
      : ''}</button>`;
  }
  calGrid.innerHTML = calHtml;

  // Rutinas del día seleccionado y rutinas adicionales de hoy
  const selectedDate = parseDateKey(selectedCalendarDate);
  const selectedDateIsToday = selectedCalendarDate === getLocalDateKey(now);
  const selectedDateIsFuture = isFutureDate(selectedCalendarDate, getLocalDateKey(now));
  const selectedDateDay = selectedDate.getDay() || 7;
  const scheduledSelectedDate = savedRoutines.filter(routine => routine.days.includes(selectedDateDay));
  const completedRoutineIdsSelectedDate = getCompletedRoutineIds(selectedCalendarDate);
  const oneTimeSelectedDate = appState.routines.filter(routine => routine.date === selectedCalendarDate);
  const routinesForSelectedDate = [
    ...scheduledSelectedDate,
    ...oneTimeSelectedDate
  ];

  const selectedDateLabel = selectedDateIsToday ? 'Hoy' : formatDisplayDate(selectedDate);
  document.getElementById('selectedRoutineDateLabel').textContent =
    selectedDateLabel.charAt(0).toLocaleUpperCase('es-ES') + selectedDateLabel.slice(1);
  document.getElementById('selectedRoutineDateTitle').textContent = scheduledSelectedDate.length
    ? 'Rutinas programadas'
    : 'Día sin rutina programada';
  document.getElementById('todayScheduledRoutines').textContent = scheduledSelectedDate.length
    ? `${scheduledSelectedDate.length} ${scheduledSelectedDate.length === 1 ? 'rutina programada' : 'rutinas programadas'} para este día.${selectedDateIsFuture ? ' Podrás marcarlas cuando llegue la fecha.' : ''}`
    : '';
  document.getElementById('noScheduledRoutineText').textContent = selectedDateIsFuture
    ? 'No puedes registrar actividad en una fecha futura.'
    : 'Descanso. Si entrenaste igual, registra tu entrenamiento y el día se marcará como completo.';
  document.getElementById('noScheduledRoutineMessage').classList.toggle('hidden', scheduledSelectedDate.length > 0);
  configureRoutineForm(scheduledSelectedDate.length === 0 && !selectedDateIsFuture, selectedCalendarDate);

  const todayRoutinesList = document.getElementById('todayRoutinesList');
  todayRoutinesList.innerHTML = renderTodayRoutineCards(
    routinesForSelectedDate,
    completedRoutineIdsSelectedDate,
    selectedCalendarDate
  );
  const routinesForSelectedDateIds = new Set(routinesForSelectedDate.map(routine => routine.id));
  const otherRoutines = savedRoutines.filter(routine => !routinesForSelectedDateIds.has(routine.id));
  const otherRoutinesSection = document.getElementById('otherRoutinesSection');
  otherRoutinesSection.classList.toggle('hidden', otherRoutines.length === 0);
  document.getElementById('otherRoutinesCount').textContent = otherRoutines.length;
  document.getElementById('otherRoutinesList').innerHTML =
    renderTodayRoutineCards(otherRoutines, completedRoutineIdsSelectedDate, selectedCalendarDate);

  // Lista de rutinas guardadas
  const routinesList = document.getElementById('routinesListContainer');
  const expandedRoutineIds = new Set(
    [...routinesList.querySelectorAll('details[data-routine-id][open]')].map(details => details.dataset.routineId)
  );
  routinesList.innerHTML = savedRoutines.map(r => {
    const isActive = r.id === selectedRoutine?.id;
    return `
      <article class="rounded-2xl border ${isActive ? 'border-brand-300 bg-brand-50/40' : 'border-slate-200/80 bg-slate-50/60'} p-3.5 space-y-3">
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2">
            <h4 class="truncate text-xs font-bold text-slate-900">${r.name}</h4>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button type="button" onclick="openEditRoutineModal('${r.id}')" title="Editar rutina"
              aria-label="Editar ${r.name}"
              class="px-2 py-1 rounded-lg text-[10px] font-semibold text-brand-700 hover:bg-brand-100 transition">Editar</button>
            <button type="button" onclick="deleteRoutine('${r.id}')" title="Eliminar rutina"
              class="p-1 text-slate-400 hover:text-rose-600 text-xs font-bold">✕</button>
          </div>
        </div>
        <div>
          <div class="flex flex-wrap gap-1">
            ${WEEK_DAYS.map(day => {
      const active = r.days.includes(day.value);
      return `<button type="button" onclick="toggleRoutineDay('${r.id}', ${day.value})"
                  aria-pressed="${active}" aria-label="${active ? 'Quitar' : 'Programar'} ${day.label} para ${r.name}"
                  class="px-2 py-1 rounded-lg text-[10px] font-semibold transition ${active
          ? 'bg-brand-600 text-white'
          : 'bg-white border border-slate-200 text-slate-500 hover:bg-brand-50'}">${day.label}</button>`;
    }).join('')}
          </div>
        </div>
        <details data-routine-id="${r.id}" ${expandedRoutineIds.has(r.id) ? 'open' : ''}
          class="group border-t border-slate-200/70 pt-2">
          <summary class="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-semibold text-brand-700">
            <span>Ver ejercicios</span>
            <svg class="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6" />
            </svg>
          </summary>
          <div class="mt-3 space-y-3">
          <div>
            <p class="text-[10px] font-semibold text-amber-700 mb-1">Calentamiento</p>
            <ul class="list-disc pl-5 space-y-0.5 text-[11px] leading-relaxed text-slate-600">${renderRoutineItems(r.warmup)}</ul>
          </div>
          <div>
            <p class="text-[10px] font-semibold text-brand-700 mb-1">Ejercicio</p>
            <ul class="list-disc pl-5 space-y-0.5 text-[11px] leading-relaxed text-slate-600">${renderRoutineItems(r.main)}</ul>
          </div>
          <div>
            <p class="text-[10px] font-semibold text-water-700 mb-1">Enfriamiento</p>
            <ul class="list-disc pl-5 space-y-0.5 text-[11px] leading-relaxed text-slate-600">${renderRoutineItems(r.cooldown)}</ul>
          </div>
          </div>
        </details>
      </article>`;
  }).join('');

  renderExerciseHistory();
  updateNotificationStatusUI();
}

function renderExerciseHistory() {
  const historyList = document.getElementById('exerciseHistoryList');
  const history = [...(appState.activityHistory || [])].sort((a, b) =>
    b.date.localeCompare(a.date) || (Date.parse(b.loggedAt) || 0) - (Date.parse(a.loggedAt) || 0)
  );

  if (!history.length) {
    historyList.innerHTML = '<p class="text-xs text-slate-400 text-center py-3">Aún no hay ejercicios registrados.</p>';
    return;
  }

  const entriesByDate = new Map();
  history.forEach(entry => {
    if (!entriesByDate.has(entry.date)) entriesByDate.set(entry.date, []);
    entriesByDate.get(entry.date).push(entry);
  });

  const groupedHistory = [...entriesByDate.entries()];
  const renderHistoryGroups = groups => groups.map(([date, entries]) => `
      <article class="p-3 rounded-2xl bg-slate-50 border border-slate-200/70">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-bold text-slate-800">${formatHealthRecordDate(date)}</span>
          <span class="text-[10px] font-semibold text-slate-500">${entries.length} ${entries.length === 1 ? 'rutina' : 'rutinas'}</span>
        </div>
        <div class="mt-2 space-y-1.5">
          ${entries.map(entry => `
            <div class="flex items-start justify-between gap-3 text-[11px]">
              <span class="min-w-0 break-words text-slate-700">${entry.routineName}</span>
              <span class="shrink-0 text-slate-500">${formatActivityLoggedTime(entry.loggedAt)}</span>
            </div>
          `).join('')}
        </div>
      </article>
    `).join('');

  const recentHistory = groupedHistory.slice(0, 3);
  const olderHistory = groupedHistory.slice(3);
  historyList.innerHTML = `
    ${renderHistoryGroups(recentHistory)}
    ${olderHistory.length ? `
      <details class="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
        <summary class="cursor-pointer text-xs font-semibold text-brand-700">Ver más (${olderHistory.length})</summary>
        <div class="mt-2.5 space-y-2.5">${renderHistoryGroups(olderHistory)}</div>
      </details>
    ` : ''}
  `;
}

function renderWaterHistory() {
  const historyList = document.getElementById('waterHistoryList');
  const history = Array.isArray(appState.waterHistory) ? appState.waterHistory : [];
  const todayKey = getLocalDateKey();
  const dailyEntries = history
    .filter(entry => entry.date === todayKey)
    .sort((a, b) => (Date.parse(b.loggedAt) || 0) - (Date.parse(a.loggedAt) || 0));
  if (!dailyEntries.length) {
    historyList.innerHTML = '<p class="text-xs text-slate-400 text-center py-2">Aún no hay ingestas de agua hoy.</p>';
    return;
  }

  const visibleEntries = dailyEntries.slice(0, 3);
  const olderEntries = dailyEntries.slice(3);
  const renderEntries = entries => entries.map(entry => {
    const amountMl = Number(entry.amountMl) || 0;
    const label = amountMl < 0 ? `Ajuste: ${amountMl} ml` : `${amountMl} ml`;
    return `
      <article class="flex items-center justify-between gap-3 rounded-xl border border-slate-200/70 bg-white px-3 py-2 text-[11px]">
        <span class="font-semibold text-slate-500">${formatActivityLoggedTime(entry.loggedAt)}</span>
        <span class="shrink-0 font-bold text-water-700">${label}</span>
      </article>
    `;
  }).join('');

  historyList.innerHTML = `
    <div class="space-y-2.5">
      <div class="space-y-1.5">${renderEntries(visibleEntries)}</div>
      ${olderEntries.length ? `
        <details class="pt-1">
          <summary class="cursor-pointer text-[11px] font-semibold text-water-700">
            Ver más (${olderEntries.length} ${olderEntries.length === 1 ? 'registro' : 'registros'})
          </summary>
          <div class="mt-2 space-y-1.5">${renderEntries(olderEntries)}</div>
        </details>
      ` : ''}
    </div>
  `;
}

function applySexFromData() {
  const sex = appState.healthRecords[0]?.sex;
  if (!sex) return;
  const radio = document.querySelector(`input[name="bioSex"][value="${sex}"]`);
  if (radio) radio.checked = true;
}

function showAppVersion(version) {
  if (!version) return;
  const label = `v${version}`;
  document.getElementById('appVersion').textContent = label;
  document.getElementById('appVersionBadge').textContent = label;
}

function renderRoutineItems(items) {
  return items.split(/[,\r\n]+/).map(item => item.trim()).filter(Boolean)
    .map(item => `<li>${item}</li>`).join('');
}

function renderTodayRoutineCards(routines, completedRoutineIds, dateKey = getLocalDateKey()) {
  const dateIsFuture = isFutureDate(dateKey);
  return routines.map(routine => {
    const isComplete = completedRoutineIds.includes(routine.id);
    return `
      <article class="rounded-2xl border transition-colors ${isComplete ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-slate-50/60'} p-3.5 space-y-3">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-sm font-bold text-slate-900">${routine.name}</h3>
          ${dateIsFuture ? '' : `
            <label class="inline-flex items-center gap-2 shrink-0 cursor-pointer">
              <input type="checkbox" ${isComplete ? 'checked' : ''}
                onchange="toggleRoutineActivity('${routine.id}', '${dateKey}')"
                aria-label="${isComplete ? 'Desmarcar' : 'Marcar'} ${routine.name} como completada"
                class="peer sr-only">
              <span aria-hidden="true"
                class="flex h-5 w-5 items-center justify-center rounded border-2 border-emerald-600 bg-white text-xs font-bold text-white transition peer-checked:bg-emerald-600 peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-300">${isComplete ? '✓' : ''}</span>
            </label>
          `}
        </div>
        <div class="space-y-2 border-t border-slate-200/70 pt-3">
          <div>
            <span class="px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 font-bold text-[10px]">Calentamiento</span>
            <ul class="mt-1.5 list-disc pl-5 space-y-0.5 text-xs leading-relaxed text-slate-700">${renderRoutineItems(routine.warmup)}</ul>
          </div>
          <div>
            <span class="px-2 py-0.5 rounded-md bg-brand-100 text-brand-800 font-bold text-[10px]">Ejercicio</span>
            <ul class="mt-1.5 list-disc pl-5 space-y-0.5 text-xs leading-relaxed font-medium text-slate-800">${renderRoutineItems(routine.main)}</ul>
          </div>
          <div>
            <span class="px-2 py-0.5 rounded-md bg-water-100 text-water-800 font-bold text-[10px]">Enfriamiento</span>
            <ul class="mt-1.5 list-disc pl-5 space-y-0.5 text-xs leading-relaxed text-slate-700">${renderRoutineItems(routine.cooldown)}</ul>
          </div>
        </div>
      </article>`;
  }).join('');
}

// -----------------------------------------------------------
// INICIALIZACIÓN (carga config + datos JSON, luego renderiza)
// -----------------------------------------------------------
async function initApp() {
  try {
    const [config, activityData] = await Promise.all([
      fetchJSON('data/config.json'),
      fetchJSON('data/activity.json')
    ]);
    STORAGE_KEY = config.storageKey || STORAGE_KEY;
    WATER_CAP_ML = config.waterCapMl || WATER_CAP_ML;
    showAppVersion(config.version);
    appState = await loadState(activityData);
    applySexFromData();
    renderAll();
  } catch (err) {
    console.error(err);
    showToast('No se pudieron cargar los datos. Abre la app desde un servidor local (http://), no con file://', 'warn');
  }
}

document.addEventListener('DOMContentLoaded', initApp);
