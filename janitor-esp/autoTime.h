#pragma once
#include <GyverPortal.h>

//extern GyverPortal ui;
#define MINUTES *3600L

namespace EspTime {
    static constexpr time_t _2025_01_01_00_00_ = 1735689600LL;

    static bool informed = false;

    inline bool isSynced(){
        return time(nullptr) > _2025_01_01_00_00_;
    }
    // static constexpr uint32_t INVALID_OFFSET = 0x7FFFFFFF;
    // static int32_t _timeoffset = INVALID_OFFSET;
    // bool tzConfigured(){ return _timeoffset != INVALID_OFFSET; }
    inline bool tzConfigured(){ 
        auto _ptr = getenv("TZ");
        return _ptr != nullptr && _ptr[0] != '\0';
    };

    inline char * getTz(){
        return getenv("TZ");
    }
    inline void setTz( const char * tzStr){
        setenv("TZ", tzStr, 1);
        tzset();
    }

    // Безопасный вывод локального времени в Serial (с защитой от NULL)
inline void timeTo(Stream& s) {
        struct timeval tv;
        gettimeofday(&tv, NULL); // Получаем системное время с микросекундами
        
        time_t now = tv.tv_sec;
        // auto now = time(nullptr);
        struct tm* timeinfo = localtime(&now);
        
        // Рассчитываем миллисекунды из микросекунд
        long milliseconds = tv.tv_usec / 1000;
        auto tzStr = getenv("TZ") ? getenv("TZ") : "GMT";
        

        // char tz_name[10];
        // strftime(tz_name, sizeof(tz_name), "%Z", timeinfo);

        s.printf("Local time: %02d:%02d:%02d.%03ld %s\n",
                timeinfo->tm_hour, 
                timeinfo->tm_min, 
                timeinfo->tm_sec, 
                milliseconds,
                tzStr
                );
        
        timeinfo = gmtime(&now); // Это ЧИСТЫЙ UTC (например, 14:19)       
        //time_t utc = mktime(utcTm);

        s.printf("UTC time: %02d:%02d:%02d\n",
            timeinfo->tm_hour, 
            timeinfo->tm_min, 
            timeinfo->tm_sec 
        );
    }

    // Скрипт для отображения часов (запрашивает локальный timestamp у ESP)
    const char SCRIPT[] PROGMEM = R"raw(
<script>
let _espTime = 0;
function _updCl() {
    if (!_espTime) return;
    let d = new Date( _espTime * 1000 ); 
    let h = d.getHours().toString().padStart(2, '0');
    let m = d.getMinutes().toString().padStart(2, '0');
    let s = d.getSeconds().toString().padStart(2, '0');   
    const el = document.getElementById('gh_clk');
    if (el) el.innerHTML = `${h}:${m}:${s}`;
    _espTime++;
}
async function _sync() {
    try {
        let r = await fetch('/get_time');
        _espTime = parseInt(await r.text());
    } catch(e){
        console.log(e);
    }
}
setInterval(_updCl, 1000);
setInterval(_sync, 10000);
setTimeout(_sync, 700); 
</script>
<div style="font-family:monospace;font-size:20px" id="gh_clk">--:--:--</div>
)raw";

    // Обработчик /get_time – возвращает локальный timestamp
    inline void handler(ESP8266WebServer& s) {
        s.on("/get_time", [&s]() {
            time_t now = time(nullptr);               // UTC
            s.send(200, "text/plain", String(now));
            //timeTo( Serial);
        });
    }
};

namespace AutoTime {
    // Скрипт, отправляющий время браузера и TZ на ESP (при загрузке и каждую минуту)
    const char SCRIPT[] PROGMEM = R"raw(
<script>
function syncTimeWithESP() {
    const utcSeconds = Math.floor(Date.now() / 1000); 
    const offsetMinutes = -new Date().getTimezoneOffset();
    const offsetHours = offsetMinutes / 60;
    const sign = offsetHours >= 0 ? '-' : '+';
    const posix = `GMT${sign}${Math.abs(offsetHours)}`;
    let savedTz = document.getElementById("tz");
    if ( savedTz.value == '' ) savedTz.value = posix;
    fetch(`/set_time?utc=${utcSeconds}&offset=${offsetMinutes}&tz=${encodeURIComponent(posix)}`)
        .catch(e => console.log(e));
}
window.onload = function() {
    syncTimeWithESP();
    setInterval(syncTimeWithESP, 60000); 
};
</script>
)raw";


/*     fetch(`/set_time?utc=${utcSeconds}&offset=${offsetMinutes}&tz=${encodeURIComponent(posix)}`)
        .then(r => console.log(r.statusText))
        .catch(e => console.log(e));
         */


    //static bool tzConfigured = false; // флаг: TZ уже установлен (сбрасывается при перезагрузке)

    inline void handler(ESP8266WebServer& s, const char* ntp1 = "ru.pool.ntp.org", const char* ntp2 = nullptr, const char* ntp3 = nullptr) {
        s.on("/set_time", [&s, ntp1, ntp2, ntp3]() {

            if (!s.hasArg("tz") || !s.hasArg("offset")) {
                s.send(400, "text/plain", "Missing tz");
                return;
            }

            String tz = s.arg("tz");
            //EspTime::_timeoffset = s.arg("offset").toInt();
                        

            // Устанавливаем начальное время из браузера (чтобы часы сразу пошли правильно)
            if (s.hasArg("utc")) {
                time_t utc = (time_t)s.arg("utc").toInt();
                struct timeval tv = { .tv_sec = utc, .tv_usec = 0 };
                settimeofday(&tv, NULL);
            }   

            // Если TZ уже был настроен – игнорируем (просто отвечаем 200)
            if (EspTime::tzConfigured()) {
                configTime( EspTime::getTz(), ntp1, ntp2, ntp3);

                // s.send(200);
                // return;
            } else {
                // (Пере)запускаем NTP с нулевым смещением (встроенный SNTP будет обновлять время)
                configTime(0, 0, ntp1, ntp2, ntp3);
                // Устанавливаем временную зону через переменную окружения
                EspTime::setTz( tz.c_str());
            }
            // setenv("TZ", tz.c_str(), 1);
            // tzset();


            s.send(200);
        });
    }
};

