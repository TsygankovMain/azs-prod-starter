/**
 * Чистые хелперы для обёртки fetch в plugins/00.diag.client.ts.
 *
 * Вынесены в отдельный модуль, чтобы их можно было покрыть тестами
 * (node --test не поднимает браузер, но Request/URL — глобальные и в Node,
 * так что сама логика разбора проверяется без DOM).
 */

/**
 * Определяет HTTP-метод запроса из аргументов fetch(): явный init.method
 * важнее метода объекта Request, иначе — GET. Так совпадает с тем, что
 * реально уйдёт в сеть.
 */
export function resolveRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
}

/**
 * Достаёт URL-строку из первого аргумента fetch(), какой бы формы он ни был.
 */
export function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

/**
 * Проверяет, что запрос идёт на наш собственный origin — только на такие
 * запросы вешается заголовок X-Diag-Session (см. 00.diag.client.ts).
 *
 * Сравнение через new URL(...).origin, а не через url.startsWith(appOrigin):
 * голый startsWith пропускал protocol-relative URL
 * ('//evil.example/x'.startsWith('/') === true) и суффиксный спуфинг origin'а
 * ('https://app.test.evil.example' начинается с 'https://app.test') — в обоих
 * случаях заголовок с ID сессии ушёл бы на чужой хост. При некорректном URL
 * считаем запрос чужим и ничего не бросаем — это только влияет на то, вешать
 * ли заголовок, а не на сам fetch.
 */
export function isOwnOriginRequestUrl(url: string, appOrigin: string): boolean {
  try {
    return new URL(url, appOrigin).origin === appOrigin
  } catch {
    return false
  }
}
