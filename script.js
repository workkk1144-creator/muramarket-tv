/* =====================================================
   НАСТРОЙКИ — меняйте только этот блок
   ===================================================== */
const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbzj4Pi2M0ZS8RYT6oAq3ZvVb9u2Ew3idjtQ57Ccqdwn27wPgIkwqRTeTWEKMPS7v-hMUw/exec',
  REFRESH_MS: 15000,     // как часто опрашивать таблицу
  CURRENCY: '₴',         // символ валюты, напр. 'лей', '₽', '$'
  MAX_COLUMNS: 6,        // верхний предел числа колонок на экране
  MAX_FAILS_BEFORE_BANNER: 2, // после скольких неудачных подряд обновлений показывать баннер
};

let lastSignature = '';
let mainEl, statusEl;
let failCount = 0;

/* ================= ЗАГРУЗКА ДАННЫХ ================= */
async function load(){
  try{
    const res = await fetch(`${CONFIG.API_URL}?t=${Date.now()}`, { cache:'no-store' });
    const rawText = await res.text();

    if(!res.ok){
      throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 200)}`);
    }

    let json;
    try{
      json = JSON.parse(rawText);
    }catch(parseErr){
      // Пришёл не JSON — почти всегда это означает, что Google Apps Script
      // вернул страницу авторизации или ошибку квоты вместо ответа нашего
      // скрипта. Показываем начало текста, чтобы было видно, что именно.
      throw new Error(`Не JSON-ответ: ${rawText.slice(0, 200)}`);
    }

    // Поддерживаем ОБА формата ответа:
    // - новый: {"ok":true,"items":[...]}
    // - старый (если Code.js на сервере ещё не обновлён до новой версии):
    //   просто массив товаров [...] без обёртки.
    // Так фронтенд работает независимо от того, какая версия Code.js
    // сейчас реально развёрнута.
    let items;
    if(Array.isArray(json)){
      items = json;
    } else if(json && json.ok){
      items = json.items || [];
    } else {
      throw new Error((json && json.error) || `Ответ без ok:true: ${rawText.slice(0, 200)}`);
    }
    localStorage.setItem('mm_cache', JSON.stringify(items));
    failCount = 0;
    setStatus(true);
    hideBanner();
    applyData(items);
  }catch(err){
    console.error('Ошибка загрузки:', err);
    failCount++;
    setStatus(false);

    const cached = localStorage.getItem('mm_cache');
    if(cached && !mainEl.dataset.rendered){
      applyData(JSON.parse(cached));
    } else if(!mainEl.dataset.rendered){
      mainEl.innerHTML = `
        <div class="error-box">
          <div>Не удалось загрузить товары</div>
          <div class="sub">Проверьте, что ссылка API верна и веб-приложение
          развёрнуто с доступом «Все, даже без входа в аккаунт».<br>${escapeHtml(String(err))}</div>
        </div>`;
    }

    // Если сбои повторяются даже ПОСЛЕ успешной первой загрузки — это раньше
    // проходило незаметно (оставались старые данные без изменений). Теперь
    // показываем баннер прямо на экране, чтобы было видно, что обновление
    // не доходит, а не просто "наличие почему-то не меняется".
    if(mainEl.dataset.rendered && failCount >= CONFIG.MAX_FAILS_BEFORE_BANNER){
      showBanner(String(err.message || err));
    }

    // Быстрая повторная попытка через 3 сек. вместо ожидания полного
    // интервала — многие сбои (квота/сеть) кратковременны и сами проходят.
    if(failCount < 5){
      setTimeout(load, 3000);
    }
  }
}

function setStatus(ok){
  if(!statusEl) return;
  statusEl.classList.toggle('warn', !ok);
}

function showBanner(errText){
  let banner = document.getElementById('banner');
  if(!banner){
    banner = document.createElement('div');
    banner.id = 'banner';
    banner.className = 'banner';
    document.querySelector('.app').appendChild(banner);
  }
  banner.textContent = `Обновление не доходит уже ${failCount} раз(а) подряд — данные на экране могут быть устаревшими. (${errText})`;
}

function hideBanner(){
  const banner = document.getElementById('banner');
  if(banner) banner.remove();
}

/* ================= РЕНДЕР (с защитой от лишних перерисовок) ================= */
function applyData(items){
  const signature = JSON.stringify(items);
  if(signature === lastSignature) return;

  const prevItems = lastSignature ? JSON.parse(lastSignature) : [];
  lastSignature = signature;

  renderAndFit(items, prevItems);
  mainEl.dataset.rendered = '1';
}

function groupByCategory(items){
  const grouped = {};
  items.forEach(p=>{
    if(!grouped[p.category]) grouped[p.category] = [];
    grouped[p.category].push(p);
  });
  return grouped;
}

function keyOf(p){ return `${p.category}__${p.name}`; }

function formatPrice(value){
  const num = Number(value) || 0;
  return num % 1 === 0
    ? num.toLocaleString('ru-RU')
    : num.toLocaleString('ru-RU', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* Строит HTML-строку одного товара */
function buildRowHtml(p, prevMap){
  const prev = prevMap[keyOf(p)];
  const changed = prev && (prev.available !== p.available || prev.price !== p.price);
  const offClass = p.available ? '' : ' off';
  const flashClass = changed ? ' flash' : '';

  return `
    <div class="row${offClass}${flashClass}">
      <div class="name">${escapeHtml(p.name)}</div>
      <div class="meta">
        <div class="price">${formatPrice(p.price)} ${CONFIG.CURRENCY}</div>
        <div class="badge ${p.available ? 'ok' : 'no'}">${p.available ? 'Есть' : 'Нет'}</div>
      </div>
    </div>`;
}

/* ================= РАСКЛАДКА И АВТОМАСШТАБ =================
   Колонки заполняются СТРОГО ПО ПОРЯДКУ (как текст читают — сверху вниз,
   слева направо): набираем первую колонку примерно до среднего объёма,
   потом переходим ко второй и т.д. Если что-то не делится ровно —
   остаток естественно попадает в ПОСЛЕДНЮЮ колонку, а не в случайную
   середину (в отличие от автобаланса браузера).
*/
function renderAndFit(items, prevItems){
  if(items.length === 0){
    mainEl.innerHTML = `<div class="loader">Нет товаров в таблице</div>`;
    return;
  }

  const prevMap = {};
  prevItems.forEach(p => prevMap[keyOf(p)] = p);

  const rowsHtml = items.map(p => buildRowHtml(p, prevMap));
  const heights = measureHeights(rowsHtml);

  mainEl.classList.remove('roomy');
  const available = mainEl.clientHeight || window.innerHeight * 0.6;

  const maxCols = Math.min(CONFIG.MAX_COLUMNS, Math.max(1, items.length));
  let best = null;

  for(let cols = 1; cols <= maxCols; cols++){
    const columns = layoutSequential(heights, cols);
    const boardHtml = columns.map(idxs =>
      `<div class="col">${idxs.map(i => rowsHtml[i]).join('')}</div>`
    ).join('');

    mainEl.innerHTML = `<div class="board" id="board">${boardHtml}</div>`;
    const boardEl = document.getElementById('board');
    void boardEl.offsetHeight;

    const contentH = boardEl.scrollHeight;
    const scale = Math.min(1, available / contentH);

    if(!best || scale > best.scale + 0.01){
      best = { cols, scale, boardHtml };
    }
  }

  mainEl.innerHTML = `<div class="board" id="board">${best.boardHtml}</div>`;
  const boardEl = document.getElementById('board');
  void boardEl.offsetHeight;

  if(best.scale < 1){
    boardEl.style.transform = `scale(${(best.scale * 0.995).toFixed(4)})`;
  } else {
    boardEl.style.transform = 'scale(1)';
    mainEl.classList.add('roomy');
  }
}

/* Последовательно распределяет товары по N колонкам по их реальной высоте.
   Цель для каждой колонки пересчитывается заново как «остаток высоты» /
   «осталось колонок» — это не даёт мелким отклонениям накапливаться
   в середине: если где-то набралось чуть меньше цели, следующие колонки
   это компенсируют, а не «сирота» посередине экрана. Последняя колонка
   всегда получает весь оставшийся хвост. */
function layoutSequential(heights, colCount){
  const n = heights.length;
  const columns = Array.from({ length: colCount }, () => []);

  let idx = 0;
  let remaining = heights.reduce((a, b) => a + b, 0);

  for(let col = 0; col < colCount; col++){
    if(col === colCount - 1){
      while(idx < n){
        columns[col].push(idx);
        remaining -= heights[idx];
        idx++;
      }
      break;
    }

    const colsLeft = colCount - col;
    const target = remaining / colsLeft;
    let acc = 0;

    while(idx < n){
      if(acc >= target && columns[col].length > 0) break;
      columns[col].push(idx);
      acc += heights[idx];
      remaining -= heights[idx];
      idx++;
    }
  }

  return columns;
}

/* Замеряет реальную высоту строк в скрытой офф-скрин области */
function measureHeights(rowsHtml){
  const stage = document.createElement('div');
  stage.style.position = 'absolute';
  stage.style.visibility = 'hidden';
  stage.style.pointerEvents = 'none';
  stage.style.top = '0';
  stage.style.left = '-9999px';
  stage.style.width = '480px';
  document.body.appendChild(stage);

  const heights = rowsHtml.map(html => {
    stage.innerHTML = html;
    return stage.firstElementChild.offsetHeight;
  });

  document.body.removeChild(stage);
  return heights;
}

/* ================= СТАРТ ================= */
window.addEventListener('DOMContentLoaded', ()=>{
  mainEl = document.getElementById('main');
  statusEl = document.getElementById('status');

  load();
  setInterval(load, CONFIG.REFRESH_MS);

  window.addEventListener('resize', ()=>{
    if(lastSignature){
      const items = JSON.parse(lastSignature);
      renderAndFit(items, items);
    }
  });
});
