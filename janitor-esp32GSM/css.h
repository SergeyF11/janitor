#pragma once

namespace CSS {
const char _portal[] PROGMEM =  "<style>"
 /* Переопределение фона панели вкладок */
  ".navtab > ul {"
  "  background-color: #0a2f5a !important;"  /* тёмно-синий */
  "  border-radius: 8px;"
  "  padding: 4px;"
  "}"
  /* Убираем фон у элементов списка */
  ".navtab > ul > li {"
  "  background-color: transparent;"
  "  padding: 0;"  /* убираем лишние отступы, если есть */
  "}"
  /* Стили для ссылок-вкладок */
  ".navtab > ul > li > a {"
  "  color: white !important;"
  "  padding: 8px 16px;"
  "  text-decoration: none;"
  "  display: block;"
  "  border-radius: 6px;"
  "  background-color: transparent;"
  "}"
  /* При наведении */
  ".navtab > ul > li > a:hover {"
  "  background-color: #1a4a7a !important;"  /* светлее */
  "}"
  /* Активная вкладка */
  ".navtab > ul > li.active > a {"
  "  background-color: #1a4a7a !important;"
  "  font-weight: bold;"
  "}"

    /* кнопки */
"input[type='submit'] {"
"  background-color: #0a2f5a;"   /* тёмно-синий */
"  color: white;"
"  border: none;"
"  padding: 8px 16px;"
"  border-radius: 6px;"
"  cursor: pointer;"
"  font-weight: bold;"
"}"
"input[type='submit']:hover {"
"  background-color: #1a4a7a;"   /* чуть светлее при наведении */
"}"

"</style>"
  ;
}