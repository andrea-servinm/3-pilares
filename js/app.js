// -----------------------------------------------------------
// 2. UTILIDADES DE FECHA Y ESTADO EN LOCALSTORAGE
// -----------------------------------------------------------
let STORAGE_KEY = 'mi_seguimiento_diario_v1';
let WATER_CAP_ML = 2500;

function getLocalDateKey(dateObj = new Date()) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDisplayDate(dateObj = new Date()) {
  return dateObj.toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });
}

// Carga un JSON desde /data
async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`No se pudo cargar ${path} (${res.status})`);
  return res.json();
}

// Construye el estado inicial a partir de los archivos JSON de /data
async function createInitialState() {
  const [water, routines, activity, health, reminders] = await Promise.all([
    fetchJSON('data/water.json'),
    fetchJSON('data/routines.json'),
    fetchJSON('data/activity.json'),
    fetchJSON('data/health-records.json'),
    fetchJSON('data/reminders.json')
  ]);

  const today = new Date();
  const todayKey = getLocalDateKey(today);

  const completedDates = [];
  const activityLog = {}; // fecha -> id de rutina realizada

  // a) Relativos: "hace N días" (opcional)
  (activity.completedDaysAgo || []).forEach(entry => {
    const daysAgo = typeof entry === 'object' ? entry.daysAgo : entry;
    const routineId = typeof entry === 'object' ? entry.routineId : null;
    const prev = new Date(today);
    prev.setDate(today.getDate() - daysAgo);
    if (!activity.onlyCurrentMonth || prev.getMonth() === today.getMonth()) {
      const key = getLocalDateKey(prev);
      completedDates.push(key);
      if (routineId) activityLog[key] = routineId;
    }
  });

  // b) Fechas fijas: "AAAA-MM-DD" o { date, routineId }
  const currentMonthPrefix = todayKey.slice(0, 7);
  (activity.completedDates || []).forEach(entry => {
    const date = typeof entry === 'object' ? entry.date : entry;
    const routineId = typeof entry === 'object' ? entry.routineId : null;
    if (activity.onlyCurrentMonth && !date.startsWith(currentMonthPrefix)) return;
    if (!completedDates.includes(date)) completedDates.push(date);
    if (routineId) activityLog[date] = routineId;
  });

  const healthRecords = health.records.map(({ monthsAgo, ...rec }) => {
    const d = new Date(today);
    d.setMonth(today.getMonth() - (monthsAgo || 0));
    return { ...rec, date: getLocalDateKey(d) };
  });

  return {
    waterLogs: { [todayKey]: water.todayInitialMl },
    routines: routines.routines,
    selectedRoutineId: routines.selectedRoutineId,
    completedActivityDates: completedDates,
    activityLog,
    healthRecords,
    reminders
  };
}

async function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const initial = await createInitialState();
      saveState(initial);
      return initial;
    }
    const parsed = JSON.parse(raw);
    parsed.activityLog = parsed.activityLog || {};
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

function addWater(deltaMl) {
  const key = getLocalDateKey();
  const current = getTodayWater();

  if (deltaMl > 0 && current >= WATER_CAP_ML) {
    showToast('¡Ya alcanzaste el tope diario de 2500 ml!', 'warn');
    return;
  }

  const updated = Math.max(0, Math.min(WATER_CAP_ML, current + deltaMl));
  appState.waterLogs[key] = updated;
  saveState(appState);
  renderAll();

  if (updated === WATER_CAP_ML && current < WATER_CAP_ML) {
    showToast('¡Meta diaria de 2500 ml completada! 💧');
  } else if (deltaMl > 0) {
    showToast(`+${deltaMl} ml registrados (${updated} / 2500 ml)`);
  } else {
    showToast(`Ajustado a ${updated} ml`);
  }
}

function resetTodayWater() {
  const key = getLocalDateKey();
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
  let imcCategory = 'Normopeso';
  if (imc < 18.5) imcCategory = 'Bajo peso';
  else if (imc >= 25 && imc < 30) imcCategory = 'Sobrepeso';
  else if (imc >= 30) imcCategory = 'Obesidad';

  // Umbrales orientativos OMS para ICC y estándar ICA (0.50)
  const iccThreshold = sex === 'M' ? 0.90 : 0.85;
  const highIcc = icc >= iccThreshold;
  const highIca = ica >= 0.50;
  const veryHighIca = ica >= 0.60;

  let riskLevel = 'Riesgo Bajo';
  let riskBadgeClass = 'bg-emerald-100 text-emerald-800';
  let explanation = 'Tus proporciones cintura-altura (ICA < 0.50) y cintura-cadera se ubican en rango saludable.';

  let riskPoints = 0;
  if (imc >= 25) riskPoints += 1;
  if (imc >= 30) riskPoints += 1;
  if (highIcc) riskPoints += 1;
  if (highIca) riskPoints += 1;
  if (veryHighIca) riskPoints += 1;

  if (riskPoints >= 3) {
    riskLevel = 'Riesgo Elevado';
    riskBadgeClass = 'bg-rose-100 text-rose-800';
    explanation = 'Adiposidad central elevada según ICA/ICC e IMC. Se sugiere seguimiento constante de hábitos y consulta preventiva.';
  } else if (riskPoints >= 1) {
    riskLevel = 'Riesgo Moderado';
    riskBadgeClass = 'bg-amber-100 text-amber-800';
    explanation = 'Al menos un indicador (IMC, ICC o ICA) supera el umbral óptimo. Mantener actividad regular e hidratación ayudará a mejorarlo.';
  }

  return {
    imc: Number(imc.toFixed(1)),
    icc: Number(icc.toFixed(2)),
    ica: Number(ica.toFixed(2)),
    imcCategory,
    iccStatus: highIcc ? 'Elevado' : 'Óptimo',
    icaStatus: highIca ? 'Elevado' : 'Óptimo',
    riskLevel,
    riskBadgeClass,
    explanation
  };
}

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

function toggleTodayActivity() {
  const todayKey = getLocalDateKey();
  const idx = appState.completedActivityDates.indexOf(todayKey);
  appState.activityLog = appState.activityLog || {};

  if (idx === -1) {
    appState.completedActivityDates.push(todayKey);
    appState.activityLog[todayKey] = appState.selectedRoutineId;   // <-- nueva
    showToast('¡Rutina del día marcada como completada! 🔥');
  } else {
    appState.completedActivityDates.splice(idx, 1);
    delete appState.activityLog[todayKey];                          // <-- nueva
    showToast('Rutina de hoy desmarcada');
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

// Calcula días cumplidos en el mes calendario actual
function getMonthlyStreakCount() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `${year}-${month}-`;

  return appState.completedActivityDates.filter(d => d.startsWith(prefix)).length;
}

// Selector de rutina del día
document.getElementById('todayRoutineSelect').addEventListener('change', function (e) {
  appState.selectedRoutineId = e.target.value;
  saveState(appState);
  renderAll();
});

// Formulario Nueva Rutina
const newRoutineForm = document.getElementById('newRoutineForm');
document.getElementById('toggleNewRoutineFormBtn').addEventListener('click', () => {
  newRoutineForm.classList.toggle('hidden');
});
document.getElementById('cancelNewRoutineBtn').addEventListener('click', () => {
  newRoutineForm.classList.add('hidden');
  newRoutineForm.reset();
});

newRoutineForm.addEventListener('submit', function (e) {
  e.preventDefault();
  const name = document.getElementById('routineNameInput').value.trim();
  const warmup = document.getElementById('routineWarmupInput').value.trim();
  const main = document.getElementById('routineMainInput').value.trim();
  const cooldown = document.getElementById('routineCooldownInput').value.trim();

  if (!name || !warmup || !main || !cooldown) return;

  const newRut = {
    id: 'rut-' + Date.now(),
    name,
    warmup,
    main,
    cooldown
  };

  appState.routines.push(newRut);
  appState.selectedRoutineId = newRut.id;
  saveState(appState);

  newRoutineForm.reset();
  newRoutineForm.classList.add('hidden');
  renderAll();
  showToast('Nueva rutina agregada y seleccionada');
});

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
  const selectedRoutine = appState.routines.find(r => r.id === appState.selectedRoutineId) || appState.routines[0];
  const latestHealth = appState.healthRecords[0] || null;

  // --- RENDER PESTAÑA RESUMEN ---
  const dailyScore = Math.round((waterPct * 0.5) + (activityDone ? 50 : 0));
  document.getElementById('summaryScoreBadge').textContent = `${dailyScore}%`;
  document.getElementById('heroWaterText').textContent = `${waterToday} / ${WATER_CAP_ML} ml`;
  document.getElementById('heroActivityText').textContent = activityDone ? 'Completada ✓' : 'Pendiente';

  const heroWeeklyEl = document.getElementById('heroWeeklyStreak');
  const heroMonthlyEl = document.getElementById('heroMonthlyStreak');
  if (heroWeeklyEl) heroWeeklyEl.textContent = `${weeklyStreak} / 7 días`;
  if (heroMonthlyEl) heroMonthlyEl.textContent = `${monthlyStreak} días`;

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

  document.getElementById('summaryRoutineName').textContent = selectedRoutine ? selectedRoutine.name : 'Sin rutina';
  const badgeEl = document.getElementById('summaryActivityBadge');
  const toggleSummaryBtn = document.getElementById('summaryToggleActivityBtn');

  if (activityDone) {
    badgeEl.textContent = 'Completada ✓';
    badgeEl.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800';
    toggleSummaryBtn.textContent = 'Rutina de hoy completada (Tocar para desmarcar)';
    toggleSummaryBtn.className = 'w-full py-2.5 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:scale-[0.99] text-white text-xs font-bold transition shadow-sm';
  } else {
    badgeEl.textContent = 'Pendiente';
    badgeEl.className = 'px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800';
    toggleSummaryBtn.textContent = 'Marcar rutina de hoy como completada';
    toggleSummaryBtn.className = 'w-full py-2.5 rounded-2xl bg-brand-600 hover:bg-brand-700 active:scale-[0.99] text-white text-xs font-semibold transition shadow-sm';
  }

  document.getElementById('summaryWeeklyStreak').textContent = weeklyStreak;
  document.getElementById('summaryMonthlyStreak').textContent = monthlyStreak;
  const daysInCurrentMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  document.getElementById('summaryMonthDaysTotal').textContent = `/ ${daysInCurrentMonth} días`;
  document.getElementById('summaryMonthLabel').textContent = now.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

  if (latestHealth) {
    document.getElementById('summaryLastCheckDate').textContent = `Registrado el ${latestHealth.date}`;
    const riskBadge = document.getElementById('summaryRiskBadge');
    riskBadge.textContent = latestHealth.riskLevel;
    riskBadge.className = `px-2.5 py-1 rounded-full text-xs font-bold ${latestHealth.riskBadgeClass}`;

    document.getElementById('summaryImcVal').textContent = latestHealth.imc;
    document.getElementById('summaryImcCat').textContent = latestHealth.imcCategory;
    document.getElementById('summaryIccVal').textContent = latestHealth.icc;
    document.getElementById('summaryIcaVal').textContent = latestHealth.ica;
  } else {
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

  if (latestHealth) {
    document.getElementById('latestHealthResultCard').classList.remove('hidden');
    const hTag = document.getElementById('healthRiskTag');
    hTag.textContent = latestHealth.riskLevel;
    hTag.className = `px-2.5 py-0.5 rounded-full text-xs font-bold ${latestHealth.riskBadgeClass}`;

    document.getElementById('resImc').textContent = latestHealth.imc;
    document.getElementById('resImcLabel').textContent = latestHealth.imcCategory;
    document.getElementById('resIcc').textContent = latestHealth.icc;
    document.getElementById('resIccLabel').textContent = latestHealth.iccStatus;
    document.getElementById('resIca').textContent = latestHealth.ica;
    document.getElementById('resIcaLabel').textContent = latestHealth.icaStatus;
    document.getElementById('resRiskExplanation').textContent = latestHealth.explanation;

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
    historyContainer.innerHTML = appState.healthRecords.map(rec => `
          <div class="p-3 rounded-2xl bg-slate-50 border border-slate-200/70 flex items-center justify-between gap-2">
            <div>
              <div class="flex items-center gap-2">
                <span class="text-xs font-bold text-slate-800">${rec.date}</span>
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
  }

  // --- RENDER PESTAÑA ACTIVIDAD ---
  document.getElementById('actWeeklyCount').textContent = weeklyStreak;
  document.getElementById('actMonthlyCount').textContent = monthlyStreak;
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
    const done = appState.completedActivityDates.includes(dKey);
    const isToday = d === todayDateNum;

    let cellClass = 'h-8 rounded-xl flex items-center justify-center text-xs font-semibold transition ';
    if (done) {
      cellClass += 'bg-brand-600 text-white font-bold shadow-xs';
    } else if (isToday) {
      cellClass += 'bg-brand-50 text-brand-700 border-2 border-brand-500 font-bold';
    } else {
      cellClass += 'bg-slate-50 text-slate-600';
    }
    const routineName = done
      ? (appState.routines.find(r => r.id === (appState.activityLog || {})[dKey])?.name || '')
      : '';
    const titleAttr = routineName ? ` title="${routineName}"` : '';
    calHtml += `<div class="${cellClass}"${titleAttr}>${d}</div>`;
  }
  calGrid.innerHTML = calHtml;

  // Select de Rutina del Día
  const selectEl = document.getElementById('todayRoutineSelect');
  selectEl.innerHTML = appState.routines.map(r => `
        <option value="${r.id}" ${r.id === selectedRoutine?.id ? 'selected' : ''}>${r.name}</option>
      `).join('');

  // Vista previa de las 3 fases
  const previewEl = document.getElementById('selectedRoutinePreview');
  if (selectedRoutine) {
    previewEl.innerHTML = `
          <div class="flex items-start gap-2">
            <span class="px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 font-bold text-[10px] shrink-0">Calentamiento</span>
            <span class="text-slate-700">${selectedRoutine.warmup}</span>
          </div>
          <div class="flex items-start gap-2">
            <span class="px-2 py-0.5 rounded-md bg-brand-100 text-brand-800 font-bold text-[10px] shrink-0">Ejercicio</span>
            <span class="text-slate-800 font-medium">${selectedRoutine.main}</span>
          </div>
          <div class="flex items-start gap-2">
            <span class="px-2 py-0.5 rounded-md bg-water-100 text-water-800 font-bold text-[10px] shrink-0">Enfriamiento</span>
            <span class="text-slate-700">${selectedRoutine.cooldown}</span>
          </div>
        `;
  }

  // Botón principal de completar rutina de hoy
  const mainBtn = document.getElementById('mainCompleteRoutineBtn');
  const mainBtnText = document.getElementById('mainCompleteRoutineText');
  if (activityDone) {
    mainBtn.className = 'w-full py-3.5 px-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:scale-[0.99] text-white font-bold text-sm shadow-md transition flex items-center justify-center gap-2';
    mainBtnText.textContent = '¡Rutina de Hoy Completada! ✓';
  } else {
    mainBtn.className = 'w-full py-3.5 px-4 rounded-2xl bg-brand-600 hover:bg-brand-700 active:scale-[0.99] text-white font-bold text-sm shadow-md transition flex items-center justify-center gap-2';
    mainBtnText.textContent = 'Marcar Rutina de Hoy Completada';
  }

  // Lista de rutinas guardadas
  const routinesList = document.getElementById('routinesListContainer');
  routinesList.innerHTML = appState.routines.map(r => `
        <div class="p-3.5 rounded-2xl border ${r.id === selectedRoutine?.id ? 'border-brand-300 bg-brand-50/40' : 'border-slate-200/80 bg-slate-50/60'} space-y-2">
          <div class="flex items-center justify-between gap-2">
            <h4 class="text-xs font-bold text-slate-900">${r.name}</h4>
            <div class="flex items-center gap-1.5">
              ${r.id === selectedRoutine?.id
      ? '<span class="px-2 py-0.5 rounded-full bg-brand-100 text-brand-700 text-[10px] font-bold">Activa hoy</span>'
      : `<button type="button" onclick="selectRoutine('${r.id}')" class="px-2 py-0.5 rounded-lg bg-white border border-slate-200 text-[10px] font-semibold text-slate-600 hover:bg-slate-100">Usar hoy</button>`
    }
              <button type="button" onclick="deleteRoutine('${r.id}')" title="Eliminar rutina"
                class="p-1 text-slate-400 hover:text-rose-600 text-xs font-bold">✕</button>
            </div>
          </div>
          <div class="text-[11px] text-slate-600 space-y-1">
            <p><strong class="text-amber-700">Calentamiento:</strong> ${r.warmup}</p>
            <p><strong class="text-brand-700">Ejercicio:</strong> ${r.main}</p>
            <p><strong class="text-water-700">Enfriamiento:</strong> ${r.cooldown}</p>
          </div>
        </div>
      `).join('');

  updateNotificationStatusUI();
}

function selectRoutine(id) {
  appState.selectedRoutineId = id;
  saveState(appState);
  renderAll();
  showToast('Rutina seleccionada para hoy');
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

// -----------------------------------------------------------
// INICIALIZACIÓN (carga config + datos JSON, luego renderiza)
// -----------------------------------------------------------
async function initApp() {
  try {
    const config = await fetchJSON('data/config.json');
    STORAGE_KEY = config.storageKey || STORAGE_KEY;
    WATER_CAP_ML = config.waterCapMl || WATER_CAP_ML;
    showAppVersion(config.version);
    appState = await loadState();
    applySexFromData();
    renderAll();
  } catch (err) {
    console.error(err);
    showToast('No se pudieron cargar los datos. Abre la app desde un servidor local (http://), no con file://', 'warn');
  }
}

document.addEventListener('DOMContentLoaded', initApp);
