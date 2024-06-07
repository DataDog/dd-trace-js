// eslint-disable-next-line max-len
const DEFAULT_IAST_REDACTION_NAME_PATTERN = '(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)'
// eslint-disable-next-line max-len
const DEFAULT_IAST_REDACTION_VALUE_PATTERN = '(?:bearer\\s+[a-z0-9\\._\\-]+|glpat-[\\w\\-]{20}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L][\\w=\\-]+\\.ey[I-L][\\w=\\-]+(?:\\.[\\w.+/=\\-]+)?|(?:[\\-]{5}BEGIN[a-z\\s]+PRIVATE\\sKEY[\\-]{5}[^\\-]+[\\-]{5}END[a-z\\s]+PRIVATE\\sKEY[\\-]{5}|ssh-rsa\\s*[a-z0-9/\\.+]{100,}))'

module.exports = {
  DEFAULT_IAST_REDACTION_NAME_PATTERN,
  DEFAULT_IAST_REDACTION_VALUE_PATTERN
}
