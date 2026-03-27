#include "gsm_mgr.h"
#include <SIM800_Modem_b.h>
#include <time.h>

extern GSMModem modem;

// ─────────────────────────────────────────────────────────────
//  _onIncomingCall()
//  Вызывается из GSM task через callback модема
// ─────────────────────────────────────────────────────────────
void GsmManager::_onIncomingCall(const String& number) {
    log_i("[GSM] Incoming call from: %s", number.c_str());

    // Нормализуем номер → uint64_t для поиска в БД
    uint64_t phoneNum = _normalizePhone(number.c_str());

    PhoneLookup found = { false, 0, 0 };
    if (xSemaphoreTake(dbMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        found = PhoneBook.findByPhone(phoneNum);
        xSemaphoreGive(dbMutex);
    }

    if (found.found) {
        // Авторизованный звонок — срабатывает первое реле в relaysMap
        uint8_t relayMask = found.relaysMap & (-found.relaysMap);  // младший установленный бит
        log_i("[GSM] Authorized call, idx=%u, relay mask=0x%02X",
              found.idx, relayMask);

        // Отклоняем звонок (не отвечаем — экономим баланс)
        modem.rejectCall();

        _enqueueRelay(relayMask, 0, found.idx, "call");
        _publishEvent("call", found.idx, "relay_triggered", relayMask);

    } else {
        // Неавторизованный звонок — отклоняем и логируем
        modem.rejectCall();
        log_i("[GSM] Unknown caller, rejected");
        _publishUnknown("call", number.c_str());
    }
}

// ─────────────────────────────────────────────────────────────
//  _onIncomingSms()
//  Вызывается из GSM task через callback модема
// ─────────────────────────────────────────────────────────────
void GsmManager::_onIncomingSms(const String& number, const String& text) {
    log_i("[GSM] SMS from %s: %s", number.c_str(), text.c_str());

    uint64_t phoneNum = _normalizePhone(number.c_str());

    PhoneLookup found = { false, 0, 0 };
    if (xSemaphoreTake(dbMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        found = PhoneBook.findByPhone(phoneNum);
        xSemaphoreGive(dbMutex);
    }

    if (found.found) {
        // Авторизованный SMS — парсим команду
        uint8_t cmdMask = _parseSmsCommand(text, _cfg ? _cfg->relayCount() : MAX_RELAYS);

        // Применяем только к разрешённым реле пользователя
        uint8_t relayMask = cmdMask & found.relaysMap;

        if (relayMask == 0) {
            // Текст не распознан или реле недоступны — применяем все разрешённые
            relayMask = found.relaysMap;
            log_i("[GSM] SMS command not parsed, triggering all allowed relays");
        }

        log_i("[GSM] Authorized SMS, idx=%u, relay mask=0x%02X", found.idx, relayMask);
        _enqueueRelay(relayMask, 0, found.idx, "sms");
        _publishEvent("sms", found.idx, "relay_triggered", relayMask);

    } else {
        // Неизвестный номер — в журнал
        log_i("[GSM] Unknown SMS sender, adding to journal");

        if (xSemaphoreTake(dbMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
            SmsLog.add(number.c_str(), text.c_str());
            xSemaphoreGive(dbMutex);
        }

        _publishUnknown("sms", number.c_str(), text.c_str());
    }
}

// ─────────────────────────────────────────────────────────────
//  _parseSmsCommand()
//  "0" → бит 0, "1" → бит 1, "Relay 1" → по имени из cfg
//  Возвращает маску реле или 0 если не распознано
// ─────────────────────────────────────────────────────────────
uint8_t GsmManager::_parseSmsCommand(const String& text, uint16_t relayCount) {
    String t = text;
    t.trim();

    if (t.length() == 0) return 0;

    // Попытка 1: цифра → индекс реле
    bool isDigit = true;
    for (size_t i = 0; i < t.length(); i++) {
        if (!isdigit(t[i])) { isDigit = false; break; }
    }
    if (isDigit) {
        int idx = t.toInt();
        if (idx >= 0 && idx < (int)relayCount) {
            return (uint8_t)(1 << idx);
        }
        return 0;
    }

    // Попытка 2: имя реле из конфига
    if (_cfg) {
        for (uint8_t i = 0; i < MAX_RELAYS; i++) {
            if (!_cfg->relays[i].isValid()) continue;
            if (t.equalsIgnoreCase(_cfg->relays[i].name)) {
                return (uint8_t)(1 << i);
            }
        }
    }

    return 0;  // не распознано
}

// ─────────────────────────────────────────────────────────────
//  _publishEvent()  — авторизованное событие (idx → бэкенд найдёт user_id)
// ─────────────────────────────────────────────────────────────
void GsmManager::_publishEvent(const char* source, uint16_t idx,
                                const char* action, uint8_t relayMask) {
    char json[192];
    snprintf(json, sizeof(json),
        "{\"type\":\"gsm_event\","
        "\"source\":\"%s\","
        "\"idx\":%u,"
        "\"action\":\"%s\","
        "\"relay_mask\":%u,"
        "\"ts\":%lu}",
        source,
        (unsigned)idx,
        action,
        (unsigned)relayMask,
        (unsigned long)time(nullptr)
    );
    _enqueueMqtt(json);
}

// ─────────────────────────────────────────────────────────────
//  _publishUnknown()  — неизвестный номер (сырой номер в событии)
// ─────────────────────────────────────────────────────────────
void GsmManager::_publishUnknown(const char* source, const char* number,
                                  const char* text) {
    char json[256];
    if (text) {
        // SMS — экранируем кавычки в тексте
        char escaped[SMSJ_TEXT_LEN * 2];
        size_t ep = 0;
        for (size_t i = 0; text[i] && ep < sizeof(escaped) - 2; i++) {
            if (text[i] == '"' || text[i] == '\\') escaped[ep++] = '\\';
            escaped[ep++] = text[i];
        }
        escaped[ep] = '\0';

        snprintf(json, sizeof(json),
            "{\"type\":\"gsm_event\","
            "\"source\":\"%s\","
            "\"action\":\"unknown\","
            "\"number\":\"%s\","
            "\"text\":\"%s\","
            "\"unread_sms\":%u,"
            "\"ts\":%lu}",
            source, number, escaped,
            SmsLog.unreadCount(),
            (unsigned long)time(nullptr)
        );
    } else {
        // Звонок
        snprintf(json, sizeof(json),
            "{\"type\":\"gsm_event\","
            "\"source\":\"%s\","
            "\"action\":\"rejected\","
            "\"number\":\"%s\","
            "\"ts\":%lu}",
            source, number,
            (unsigned long)time(nullptr)
        );
    }
    _enqueueMqtt(json);
}

// ─────────────────────────────────────────────────────────────
//  _normalizePhone()
//  "+7 (999) 123-45-67" → 79991234567 как uint64_t
//  Убирает все нечисловые символы, нормализует 8xxx → 7xxx
// ─────────────────────────────────────────────────────────────
uint64_t GsmManager::_normalizePhone(const char* raw) {
    char digits[16] = {0};
    size_t di = 0;

    for (size_t i = 0; raw[i] && di < 15; i++) {
        if (isdigit(raw[i])) digits[di++] = raw[i];
    }
    digits[di] = '\0';

    // Нормализация: 8XXXXXXXXXX → 7XXXXXXXXXX
    if (di == 11 && digits[0] == '8') digits[0] = '7';

    // Убираем ведущий + если остались только цифры
    // (+ уже убран выше)

    uint64_t result = 0;
    for (size_t i = 0; digits[i]; i++) {
        result = result * 10 + (digits[i] - '0');
    }
    return result;
}
