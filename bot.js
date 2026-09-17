const { VK } = require('vk-io');
const axios = require('axios');

// ============ НАСТРОЙКИ ============
const VK_TOKEN = 'vk1.a.F13OKYyXAzwTaR5Y461mwAYl5U1A7XGVawd9xh8bCTKpMGeUKv8-DMCl5R7axeC4rYTbct8aOkWvZlqWjW6uI29lk1dCX2YJcjHzV3XEvIVhgnd06l7qAnxYkm3ZSU7kEkoxDUBcLsA3EtVouC6sYvbTfBr4BZ1nfbW2xCH1z-oROMavFhdDOWoleolsXF119VEshF0fZZ4DrKKzuV2MYQ';
const API_URL = 'https://ar-smh.ru/api/flights';

const vk = new VK({ token: VK_TOKEN });

// Хранилище состояний пользователей
const userStates = {};

// ============ ФУНКЦИИ ============
function getSamaraNow() {
  const now = new Date();
  const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utcMs + (4 * 3600000));
}

function fmtTm(s) {
  if (!s) return '—';
  const d = new Date(s);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDt(s) {
  if (!s) return '—';
  const d = new Date(s);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Определяем эмодзи статуса
function getStatusEmoji(status) {
  if (!status) return '⚪';
  const s = status.toLowerCase();
  if (s.includes('по расписанию')) return '🟢';
  if (s.includes('регистрация') && s.includes('закончена')) return '🟠';
  if (s.includes('регистрация')) return '🔵';
  if (s.includes('посадка') && s.includes('закончена')) return '🟣';
  if (s.includes('посадка')) return '🔴';
  if (s.includes('задержан')) return '🟡';
  if (s.includes('отменён')) return '❌';
  if (s.includes('вылетел')) return '✅';
  if (s.includes('приостановлено')) return '⏸️';
  if (s.includes('питание')) return '🍽️';
  return '⚪';
}

// Формируем сообщение о рейсе
function buildFlightMessage(f) {
  const delayed = f.expectedDeparture && new Date(f.expectedDeparture) > new Date(f.scheduledDeparture);
  const statusEmoji = getStatusEmoji(f.statusText);

  let timeStr;
  if (delayed) {
    timeStr = `${fmtTm(f.scheduledDeparture)} ➡️ ${fmtTm(f.expectedDeparture)}`;
  } else {
    timeStr = fmtTm(f.scheduledDeparture);
  }

  const departure = f.expectedDeparture || f.scheduledDeparture;

  return `✈️ Рейс: ${f.flightNumber}, ${f.airline}
📍 В: ${f.destination} (${f.iataCode || ''}), ${timeStr}
🕐 Ожидается в: ${fmtDt(departure)}
🏷️ Данные: Стойки: ${f.checkInCounters || '—'}, Выход: ${f.boardingGate ? 'G' + f.boardingGate : '—'}
${statusEmoji} Статус: ${(f.statusText || 'По расписанию').replace(/\n/g, ' ')}`;
}

// Клавиатура с выбором даты
function getDateKeyboard() {
  return {
    inline: true,
    buttons: [
      [{ action: { type: 'text', label: '📅 Сегодня', payload: JSON.stringify({ cmd: 'date', value: 'today' }) }, color: 'primary' }],
      [{ action: { type: 'text', label: '📅 Завтра', payload: JSON.stringify({ cmd: 'date', value: 'tomorrow' }) }, color: 'primary' }]
    ]
  };
}

// Клавиатура "Выбрать дату заново"
function getBackKeyboard() {
  return {
    inline: true,
    buttons: [
      [{ action: { type: 'text', label: '🔄 Выбрать другую дату', payload: JSON.stringify({ cmd: 'back' }) }, color: 'secondary' }]
    ]
  };
}

// Поиск рейсов
function findFlights(flights, query, date) {
  const q = query.trim().toLowerCase();
  return flights.filter(f => {
    if (date && f.flightDay !== date) return false;
    const number = (f.flightNumber || '').toLowerCase();
    const dest = (f.destination || '').toLowerCase();
    const iata = (f.iataCode || '').toLowerCase();
    return number.includes(q) || dest.includes(q) || iata === q;
  });
}

// ============ ОБРАБОТКА СООБЩЕНИЙ ============
vk.updates.on('message_new', async (context) => {
  const userId = context.senderId;
  const text = (context.text || '').trim();
  const payload = context.messagePayload;

  // Обработка кнопок
  if (payload) {
    if (payload.cmd === 'date') {
      userStates[userId] = { step: 'search', date: payload.value };
      await context.send({
        message: `🔎 Выбрана дата: ${payload.value === 'today' ? 'Сегодня' : 'Завтра'}\n\nВведите номер рейса, город или код ИАТА (например: SU-1234, Москва, SVO):`,
        keyboard: getBackKeyboard()
      });
      return;
    }
    if (payload.cmd === 'back') {
      userStates[userId] = { step: 'date' };
      await context.send({
        message: '📅 Выберите дату:',
        keyboard: getDateKeyboard()
      });
      return;
    }
  }

  // Команды
  const lowerText = text.toLowerCase();
  if (lowerText === 'начать' || lowerText === 'start' || lowerText === 'привет' || lowerText === 'меню') {
    userStates[userId] = { step: 'date' };
    await context.send({
      message: `👋 Добро пожаловать в бота информации о статусе рейсов в аэропорту "Симашкино".\n\nПожалуйста, выберите в кнопке ниже дату, на которую вас интересует статус рейса.`,
      keyboard: getDateKeyboard()
    });
    return;
  }

  // Проверяем состояние
  const state = userStates[userId];
  if (!state || state.step !== 'search') {
    // Не знаем что делать — показываем приветствие
    userStates[userId] = { step: 'date' };
    await context.send({
      message: `👋 Добро пожаловать в бота информации о статусе рейсов в аэропорту "Симашкино".\n\nПожалуйста, выберите в кнопке ниже дату, на которую вас интересует статус рейса.`,
      keyboard: getDateKeyboard()
    });
    return;
  }

  // Поиск рейса
  try {
    const response = await axios.get(`${API_URL}?showDeparted=false`);
    const flights = response.data;
    const found = findFlights(flights, text, state.date);

    if (found.length === 0) {
      await context.send({
        message: `😔 К сожалению, рейс «${text}» не найден.\n\nПопробуйте ввести другой номер рейса, город или код ИАТА:`,
        keyboard: getBackKeyboard()
      });
      return;
    }

    // Отправляем информацию о найденных рейсах
    let msg = `🔎 Найдено рейсов: ${found.length}\n\n`;
    msg += found.slice(0, 5).map(buildFlightMessage).join('\n\n➖➖➖➖➖\n\n');

    if (found.length > 5) {
      msg += `\n\n... и ещё ${found.length - 5} рейсов. Уточните запрос.`;
    }

    await context.send({
      message: msg,
      keyboard: getBackKeyboard()
    });
  } catch (e) {
    console.error('Ошибка запроса:', e.message);
    await context.send({
      message: '⚠️ Произошла ошибка при получении данных. Попробуйте позже.',
      keyboard: getBackKeyboard()
    });
  }
});

// ============ ЗАПУСК ============
console.log('🚀 Бот аэропорта Симашкино запускается...');
vk.updates.start().then(() => {
  console.log('✅ Бот успешно запущен!');
}).catch(err => {
  console.error('❌ Ошибка запуска:', err);
});
