/* =====================================================================
   calories.js — سعرات الأطباق + حاسبة السعرات + ترشيح وطلب مباشر
   ضعه في مجلد public وأضف قبل </body> في index.html:
   <script src="/calories.js"></script>
   (لا يحتاج أي تعديل في server.js)
   القيم تقريبية للحصة الواحدة وتُعدَّل بحرية من الجدول CAL أدناه.
   ===================================================================== */
(function () {
  'use strict';

  /* ---------- السعرات الحرارية (kcal) بنفس ترتيب أحجام كل طبق في MENU ---------- */
  const CAL = {
    'كبسة دجاج سعودية': [850, 1500],   // نص حبة | حبة كاملة
    'برياني': [800, 1400],
    'جريش': [350, 550, 750],           // صغير | وسط | كبير
    'سليق': [400, 600, 800],
    'عصيدة تمر': [350, 520, 700],
    'عصيدة سكر': [330, 500, 680],
    'صينية رز بالدجاج والكريمة': [450, 900],   // صغير | وسط
    'مكرونة حمراء': [350, 700],
    'باشميل لحم': [450, 850],
    'باشميل دجاج': [400, 800],
    'باستا': [380, 750],
    'كرات بطاطس': [250, 500],
    'مقعقة لحم': [350, 700],
    'بتر تشكن مع رز أبيض': [450, 850],
    'فتة ورق عنب': [200, 380],
    'فتة باذنجان': [220, 420],
    'سلطة خضرا': [60, 120],
    'فتوش': [120, 230],
    'سلطة شمندر': [90, 170],
    'سلطة دوريتوس': [250, 450],
    'سلطة مقالي': [180, 330]
  };
  const KEY = 'tm_calc';
  const ACT = { 1.2: 'خامل (بدون رياضة)', 1.375: 'خفيف (1-3 أيام رياضة)', 1.55: 'متوسط (3-5 أيام)', 1.725: 'عالٍ (6-7 أيام)' };
  const GOALS = { lose: 'إنقاص الوزن', keep: 'تثبيت الوزن', gain: 'زيادة الوزن' };
  const g = (id) => document.getElementById(id);
  const kcalOf = (name, si) => (CAL[name] && CAL[name][si]) || 0;
  const loadP = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } };
  const saveP = (p) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) {} };
  const E = (s) => esc(s);
  const r10 = (n) => Math.round(n / 10) * 10;

  /* ---------- الحساب ----------
     - يدوي: السعرات اليومية من المدرب/الأخصائي تُعتمد كما هي (ويمكن إدخال سعرات الوجبة أيضاً)
     - تلقائي: معادلة Mifflin-St Jeor */
  function compute(f) {
    let bmr = 0, tdee = 0, daily;
    if (f.manual) daily = Math.round(f.kcal);
    else {
      bmr = 10 * f.weight + 6.25 * f.height - 5 * f.age + (f.gender === 'm' ? 5 : -161);
      tdee = bmr * f.act;
      const factor = f.goal === 'lose' ? 0.82 : f.goal === 'gain' ? 1.12 : 1;
      daily = Math.max(f.gender === 'm' ? 1500 : 1200, r10(tdee * factor));
    }
    const share = f.meals === 1 ? 0.35 : 0.65;           // حصة الاشتراك من سعرات اليوم
    const perPlan = f.mealKcal > 0 ? f.mealKcal : r10(daily * share / f.meals);
    return Object.assign({}, f, {
      bmr: Math.round(bmr), tdee: Math.round(tdee), daily,
      perPlan, planDay: perPlan * f.meals,
      perMenu: f.mealKcal > 0 ? f.mealKcal : r10(daily * 0.35)
    });
  }
  /* تكييف الملف المحفوظ مع عدد وجبات طلب اشتراك مختلف */
  const adaptTo = (p, n) => p.meals === n ? p : Object.assign({}, p, {
    meals: n, perPlan: p.mealKcal > 0 ? p.mealKcal : r10(p.daily * (n === 1 ? 0.35 : 0.65) / n), planDay: 0
  });

  /* ---------- الترشيح ---------- */
  function bestPerDish(target) {
    return flatDishes.map((d, di) => {
      let best = null;
      d.sizes.forEach((s, si) => {
        const k = kcalOf(d.name, si), diff = Math.abs(k - target);
        if (!best || diff < best.diff) best = { di, si, name: d.name, size: s[0], price: s[1], kcal: k, diff };
      });
      return best;
    }).sort((a, b) => a.diff - b.diff);
  }
  /* حصة الاشتراك = أصغر حجم (تتوافق مع سعر الوجبة في الاشتراك) */
  const planPool = (target) => flatDishes.map((d) => ({ name: d.name, diff: Math.abs(kcalOf(d.name, 0) - target) }))
    .sort((a, b) => a.diff - b.diff).slice(0, 8);
  function planSuggestion(p) {
    const pool = planPool(p.perPlan), out = {};
    for (let d = 0; d < 5; d++) {
      out[d] = [];
      for (let k = 0; k < p.meals; k++) out[d].push(pool[(d * p.meals + k) % pool.length].name);
    }
    return out;
  }
  const dayKcal = (names) => names.reduce((a, n) => a + kcalOf(n, 0), 0);
  function verdict(avg, target) {
    const r = avg / target;
    if (r >= 0.85 && r <= 1.15) return ['مناسب لهدفك ✅', 'text-emerald-600'];
    return r < 0.85 ? ['أقل من المستهدف', 'text-saffron-600'] : ['أعلى من المستهدف', 'text-rose-500'];
  }

  /* ---------- نافذة الحاسبة ---------- */
  function buildModal() {
    if (g('calcModal')) return;
    const opt = (o, sel) => Object.entries(o).map(([k, v]) => `<option value="${k}" ${String(sel) === String(k) ? 'selected' : ''}>${v}</option>`).join('');
    const p = loadP() || {}, man = !!p.manual;
    const inp = 'w-full mt-1 p-3 rounded-xl border-2 border-navy-100', sel = inp + ' bg-navy-50/40';
    document.body.insertAdjacentHTML('beforeend', `
<div id="calcModal" class="fixed inset-0 z-50 hidden bg-navy-900/60 backdrop-blur-sm flex items-center justify-center p-4" onclick="if(event.target===this)closeCalc()">
  <div class="bg-white rounded-3xl max-w-xl w-full p-6 sm:p-8 shadow-2xl max-h-[90vh] overflow-y-auto border border-navy-100">
    <div class="flex justify-between items-center border-b border-navy-100 pb-4 mb-4">
      <div class="flex items-center gap-3"><div class="w-10 h-10 rounded-xl bg-saffron-100 text-saffron-600 flex items-center justify-center"><i class="fa-solid fa-fire-flame-curved"></i></div>
      <div><h3 class="font-black text-lg">حاسبة السعرات</h3><p class="text-xs text-navy-500 font-bold">نرشّح لك الأطباق ونطلبها لك مباشرة</p></div></div>
      <button onclick="closeCalc()" class="w-8 h-8 rounded-full bg-navy-50 hover:bg-navy-100 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="grid grid-cols-2 gap-3 text-xs font-bold">
      <label class="col-span-2">كيف تريد تحديد سعراتك؟
        <select id="cMode" onchange="calcMode()" class="${sel}">${opt({ calc: 'احسب لي من بياناتي (الوزن والطول)', manual: 'عندي رقم سعرات من مدربي / أخصائي التغذية' }, man ? 'manual' : 'calc')}</select></label>
      <div id="cCalcBox" class="col-span-2 grid grid-cols-2 gap-3 ${man ? 'hidden' : ''}">
        <label>الجنس<select id="cGender" class="${sel}">${opt({ m: 'ذكر', f: 'أنثى' }, p.gender || 'm')}</select></label>
        <label>العمر (سنة)<input id="cAge" type="number" min="14" max="90" value="${p.age || ''}" class="${inp}"></label>
        <label>الوزن (كجم)<input id="cWeight" type="number" min="30" max="250" value="${p.weight || ''}" class="${inp}"></label>
        <label>الطول (سم)<input id="cHeight" type="number" min="120" max="230" value="${p.height || ''}" class="${inp}"></label>
        <label>مستوى النشاط<select id="cAct" class="${sel}">${opt(ACT, p.act || 1.375)}</select></label>
        <label>الهدف<select id="cGoal" class="${sel}">${opt(GOALS, p.goal || 'keep')}</select></label>
      </div>
      <div id="cManBox" class="col-span-2 grid grid-cols-2 gap-3 ${man ? '' : 'hidden'}">
        <label>السعرات اليومية من مختصك<input id="cKcal" type="number" min="800" max="6000" placeholder="مثال: 1800" value="${p.manual ? p.kcal : ''}" class="${inp}"></label>
        <label>سعرات الوجبة الواحدة (اختياري)<input id="cMealKcal" type="number" min="100" max="1500" placeholder="مثال: 600" value="${p.mealKcal || ''}" class="${inp}"></label>
        <p class="col-span-2 text-[11px] text-navy-500 font-medium">نعتمد رقم مختصك كما هو. إذا حدّد لك سعرات للوجبة اكتبها، وإلا نقسّم سعراتك اليومية على وجباتك تلقائياً.</p>
      </div>
      <label class="col-span-2">وجبات الاشتراك يومياً<select id="cMeals" class="${sel}">${opt({ 1: 'وجبة واحدة', 2: 'وجبتان' }, p.meals || 1)}</select></label>
    </div>
    <button onclick="runCalc()" class="w-full mt-4 bg-navy-700 hover:bg-navy-800 text-white font-bold py-3.5 rounded-2xl shadow-lg transition">رشّح لي الأطباق 🔥</button>
    <div id="calcResult" class="mt-5 space-y-4"></div>
  </div>
</div>`);
  }

  window.calcMode = function () {
    const man = g('cMode').value === 'manual';
    g('cCalcBox').classList.toggle('hidden', man);
    g('cManBox').classList.toggle('hidden', !man);
  };
  window.openCalc = function () {
    buildModal(); g('calcModal').classList.remove('hidden');
    const p = loadP(); if (p && p.daily) renderResult(p); else g('calcResult').innerHTML = '';
  };
  window.closeCalc = function () { const m = g('calcModal'); if (m) m.classList.add('hidden'); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.closeCalc(); });

  window.runCalc = function () {
    const meals = +g('cMeals').value, manual = g('cMode').value === 'manual';
    let f;
    if (manual) {
      const kcal = +g('cKcal').value, mk = +g('cMealKcal').value || 0;
      if (!(kcal >= 800 && kcal <= 6000)) { alert('يرجى إدخال السعرات اليومية (من 800 إلى 6000).'); return; }
      if (mk && !(mk >= 100 && mk <= 1500)) { alert('سعرات الوجبة يجب أن تكون بين 100 و1500، أو اتركها فارغة.'); return; }
      f = { manual: true, kcal, mealKcal: mk, meals };
    } else {
      f = { manual: false, gender: g('cGender').value, age: +g('cAge').value, weight: +g('cWeight').value, height: +g('cHeight').value,
        act: +g('cAct').value, goal: g('cGoal').value, meals, mealKcal: 0 };
      if (!(f.age >= 14 && f.age <= 90) || !(f.weight >= 30 && f.weight <= 250) || !(f.height >= 120 && f.height <= 230)) {
        alert('يرجى إدخال العمر والوزن والطول بشكل صحيح.'); return;
      }
    }
    const p = compute(f); saveP(p); renderResult(p);
  };

  function renderResult(p) {
    const days = planSuggestion(p), menuRecs = bestPerDish(p.perMenu).slice(0, 8);
    const avg = Math.round([0, 1, 2, 3, 4].reduce((a, d) => a + dayKcal(days[d]), 0) / 5), v = verdict(avg, p.planDay);
    const dayNames = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];
    const pw = PLANS.find((x) => x.id === 'w' + p.meals), pm = PLANS.find((x) => x.id === 'm' + p.meals);
    const tiles = p.manual
      ? `<div class="col-span-3 bg-saffron-50 border border-saffron-300 rounded-2xl p-3"><p class="text-[10px] text-navy-500 font-bold">سعراتك اليومية (من مختصك)</p><p class="font-black text-lg text-saffron-600">${p.daily}</p></div>`
      : `<div class="bg-navy-50 rounded-2xl p-3"><p class="text-[10px] text-navy-500 font-bold">الحرق الأساسي</p><p class="font-black text-lg">${p.bmr}</p></div>
         <div class="bg-navy-50 rounded-2xl p-3"><p class="text-[10px] text-navy-500 font-bold">احتياجك اليومي</p><p class="font-black text-lg">${p.tdee}</p></div>
         <div class="bg-saffron-50 border border-saffron-300 rounded-2xl p-3"><p class="text-[10px] text-navy-500 font-bold">هدفك (${GOALS[p.goal]})</p><p class="font-black text-lg text-saffron-600">${p.daily}</p></div>`;
    g('calcResult').innerHTML = `
      <div class="grid grid-cols-3 gap-2 text-center">${tiles}</div>
      <div class="bg-navy-50/60 border border-navy-200 rounded-2xl p-4 text-xs font-bold leading-relaxed">
        المستهدف لوجبات اشتراكك <b>${p.planDay}</b> سعرة يومياً (حوالي <b>${p.perPlan}</b> للوجبة)${p.mealKcal ? ' حسب ما حدده مختصك' : ''}.
      </div>
      <div class="space-y-2">
        <h4 class="font-black text-sm">📅 خطة مقترحة للاشتراك</h4>
        ${dayNames.map((n, d) => `<div class="flex justify-between gap-2 bg-white border border-navy-100 rounded-xl px-3 py-2 text-xs font-bold"><span>${n}</span><span class="text-navy-700 text-left">${days[d].map(E).join(' + ')}</span><span class="text-saffron-600 shrink-0">${dayKcal(days[d])} سعرة</span></div>`).join('')}
        <p class="text-xs font-black ${v[1]}">متوسط اليوم ${avg} سعرة — ${v[0]}</p>
        <div class="grid grid-cols-2 gap-2 pt-1">
          <button onclick="orderSuggested('w')" class="bg-navy-800 hover:bg-navy-700 text-white font-black text-xs py-3 rounded-xl transition">اشترك أسبوعياً بهذه الخطة<br><span class="font-bold opacity-80">${pw.price} ريال</span></button>
          <button onclick="orderSuggested('m')" class="bg-saffron-500 hover:bg-saffron-600 text-white font-black text-xs py-3 rounded-xl transition">اشترك شهرياً بهذه الخطة<br><span class="font-bold opacity-90">${pm.price} ريال</span></button>
        </div>
        <p class="text-[11px] text-navy-500 font-bold">بعد إتمام الاشتراك ستُعبّأ أطباق الأيام تلقائياً بهذه الخطة، وتعدّلها كما تشاء قبل إرسالها للإدارة. الخطة الشهرية تكرّر نفس الأسبوع.</p>
      </div>
      <div class="space-y-2">
        <h4 class="font-black text-sm">🍽️ أنسب أطباق القائمة لوجبة واحدة (≈ ${p.perMenu} سعرة)</h4>
        ${menuRecs.map((r, i) => `<label class="flex items-center justify-between gap-2 bg-white border border-navy-100 rounded-xl px-3 py-2 text-xs font-bold cursor-pointer">
          <span class="flex items-center gap-2"><input type="checkbox" class="rec-ck w-4 h-4 accent-orange-500" data-di="${r.di}" data-si="${r.si}" ${i < 3 ? 'checked' : ''}>${dishImg(r.name, 'w-10 h-10 text-lg')}<span>${E(r.name)} <span class="text-navy-400">(${E(r.size)})</span></span></span>
          <span class="text-left shrink-0"><span class="text-saffron-600">${r.kcal} سعرة</span><br><span class="text-navy-500">${r.price} ر.س</span></span></label>`).join('')}
        <button onclick="orderChecked()" class="w-full bg-navy-700 hover:bg-navy-800 text-white font-black text-xs py-3 rounded-xl transition">اطلب الأطباق المحددة 🛒</button>
      </div>
      <p class="text-[10px] text-navy-400 font-medium leading-relaxed">السعرات تقريبية وللإرشاد العام فقط وليست بديلاً عن استشارة أخصائي تغذية، خاصة لأصحاب الأمراض المزمنة والحوامل.</p>`;
  }

  /* ---------- الطلب المباشر من الترشيح ---------- */
  window.orderChecked = function () {
    const sel = [...document.querySelectorAll('#calcResult .rec-ck:checked')];
    if (!sel.length) { alert('حدّد طبقاً واحداً على الأقل.'); return; }
    closeCalc(); openBookingModal(); setType('menu');
    sel.forEach((c) => addToCart(+c.dataset.di, +c.dataset.si, 1));
  };
  window.orderSuggested = function (period) {
    const p = loadP(); if (!p) return;
    const pid = period + p.meals;
    window.__tmSuggest = { planId: pid, plan: planSuggestion(p), at: Date.now() };
    closeCalc(); selectPlan(pid);
  };

  /* ---------- إظهار السعرات في الواجهة الحالية (تغليف الدوال الموجودة) ---------- */
  const _renderMenu = window.renderMenu;
  window.renderMenu = function () {
    _renderMenu();
    document.querySelectorAll('#menuGrid button.chip').forEach((b) => {
      const m = /quickAdd\((\d+),\s*(\d+)\)/.exec(b.getAttribute('onclick') || '');
      if (!m || b.dataset.k) return;
      const k = kcalOf(flatDishes[+m[1]].name, +m[2]);
      if (k) { b.dataset.k = 1; b.insertAdjacentHTML('beforeend', `<span class="block text-[9px] font-bold text-saffron-600">${k} سعرة</span>`); }
    });
  };

  const _fillSizes = window.fillSizes;
  window.fillSizes = function () {
    _fillSizes();
    const d = flatDishes[parseInt(g('dishSelect').value)] || flatDishes[0];
    [...g('sizeSelect').options].forEach((o, i) => { o.text = `${d.sizes[i][0]} (${d.sizes[i][1]} ريال · ${kcalOf(d.name, i)} سعرة)`; });
  };

  const _renderCart = window.renderCart;
  window.renderCart = function () {
    _renderCart();
    if (!cart.length) return;
    const total = cart.reduce((a, c) => {
      const d = flatDishes.find((x) => x.name === c.name), si = d ? d.sizes.findIndex((s) => s[0] === c.size) : -1;
      return a + kcalOf(c.name, si) * c.qty;
    }, 0);
    g('cartList').insertAdjacentHTML('beforeend', `<p class="text-[11px] font-black text-saffron-600 text-center">إجمالي السعرات: ${total} سعرة</p>`);
  };

  window.dishOptions = function (sel) {
    return '<option value="">اختر الطبق</option>' + MENU.map((sec) => `<optgroup label="${esc(sec.title)}">` +
      flatDishes.filter((d) => d.section === sec.title).map((d) => `<option value="${esc(d.name)}" ${d.name === sel ? 'selected' : ''}>${esc(d.name)} · ${kcalOf(d.name, 0)} سعرة</option>`).join('') + '</optgroup>').join('');
  };

  /* ---------- نافذة أطباق الاشتراك ---------- */
  function applyPlan(sug) {
    const seen = {};
    document.querySelectorAll('#mealDays .meal-sel').forEach((s) => {
      const d = s.dataset.day, k = seen[d] = (seen[d] || 0); seen[d]++;
      if (sug[d] && sug[d][k]) s.value = sug[d][k];
    });
    sumMeals();
  }
  const _openMeal = window.openMealEditor;
  window.openMealEditor = function (id) {
    _openMeal(id);
    const box = g('mealDays'); if (!box) return;
    if (!g('mealCalBar')) {
      const p = loadP();
      box.insertAdjacentHTML('beforebegin', `<div id="mealCalBar" class="bg-navy-50 border border-navy-200 rounded-2xl p-3 mb-3 text-xs font-bold space-y-2">${
        p ? `<p>سعراتك اليومية ${p.daily}، وللاشتراك ≈ ${p.perPlan} سعرة للوجبة.</p>
            <button onclick="autoPickMeals()" class="w-full bg-saffron-500 hover:bg-saffron-600 text-white font-black py-2.5 rounded-xl transition">✨ ترشيح تلقائي حسب سعراتي</button>`
          : `<p>احسب سعراتك (أو أدخل رقم مختصك) لنرشّح لك أطباق الأسبوع.</p>
            <button onclick="closeMeal();openCalc()" class="w-full bg-navy-700 text-white font-black py-2.5 rounded-xl">افتح حاسبة السعرات 🔥</button>`}
        <p id="mealCalSum" class="text-saffron-600 font-black"></p></div>`);
      box.addEventListener('change', sumMeals);
    }
    /* تعبئة تلقائية بالخطة المرشّحة إذا جاء العميل من زر «اشترك بهذه الخطة» */
    const s = window.__tmSuggest, o = ordersCache.find((x) => x.id === id);
    if (s && o && o.plan_id === s.planId && Date.now() - s.at < 3600e3) { applyPlan(s.plan); window.__tmSuggest = null; }
    sumMeals();
  };
  const _closeMeal = window.closeMeal;
  window.closeMeal = function () { const b = g('mealCalBar'); if (b) b.remove(); _closeMeal(); };

  function sumMeals() {
    const out = g('mealCalSum'); if (!out) return;
    const byDay = {};
    document.querySelectorAll('#mealDays .meal-sel').forEach((s) => { if (s.value) (byDay[s.dataset.day] = byDay[s.dataset.day] || []).push(s.value); });
    const ds = Object.keys(byDay); if (!ds.length) { out.textContent = ''; return; }
    const avg = Math.round(ds.reduce((a, d) => a + dayKcal(byDay[d]), 0) / ds.length), p = loadP();
    out.textContent = `متوسط السعرات اليومية للأطباق المختارة: ${avg}` + (p ? ' — ' + verdict(avg, adaptTo(p, 1).planDay && p.meals === 1 ? p.planDay : (p.mealKcal > 0 ? p.mealKcal * (mealsOf(ordersCache.find((x) => x.id === mealOrderId) || {}) || 1) : p.planDay))[0] : '');
  }
  window.autoPickMeals = function () {
    const p = loadP(); if (!p) return;
    const o = ordersCache.find((x) => x.id === mealOrderId);
    applyPlan(planSuggestion(adaptTo(p, o ? mealsOf(o) : p.meals)));
  };

  /* ---------- حقن الأزرار ---------- */
  window.addEventListener('load', () => {
    buildModal();
    const acc = document.querySelector('button[onclick="openAccount()"]');
    if (acc) acc.insertAdjacentHTML('beforebegin', '<button onclick="openCalc()" class="flex items-center gap-2 text-xs font-bold bg-saffron-50 hover:bg-saffron-100 text-saffron-600 px-3 sm:px-4 py-2.5 rounded-2xl border border-saffron-300 transition"><i class="fa-solid fa-calculator"></i><span class="hidden sm:inline">حاسبة السعرات</span></button>');
    const grid = g('plansGrid');
    if (grid) grid.insertAdjacentHTML('afterend', '<div class="mt-8 text-center"><button onclick="openCalc()" class="bg-saffron-500 hover:bg-saffron-600 text-white font-black px-6 py-3.5 rounded-2xl shadow-lg transition"><i class="fa-solid fa-calculator ml-2"></i>احسب سعراتك (أو أدخل "رقم سعراتك" ) ورشّح لي الخطة</button></div>');
    window.renderMenu(); window.fillSizes(); window.renderCart();
  });
})();