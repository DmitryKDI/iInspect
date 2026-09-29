// Типы SQLCipher-сборки совпадают с better-sqlite3; пакет не публикует их через exports.
declare module 'better-sqlite3-multiple-ciphers' {
  import Database from 'better-sqlite3'
  export default Database
}
