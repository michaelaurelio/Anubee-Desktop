import { describe, it, expect } from 'vitest'
import { parseModcmpLine, parseModcmpJsonl } from '../src/shared/lib-modcmp'

describe('parseModcmpLine', () => {
  it('parses a differ record with both digests', () => {
    const r = parseModcmpLine('{"type":"modcmp","module":"libsentinel.so","path":"/data/app/~~x/base.apk","base":"0x7281a0000","pid":25659,"state":"differ","mem_sha256":"aa","file_sha256":"bb"}')
    expect(r).toEqual({ module: 'libsentinel.so', path: '/data/app/~~x/base.apk', base: '0x7281a0000', pid: 25659, state: 'differ', memSha256: 'aa', fileSha256: 'bb' })
  })
  it('maps null digests to null (nofile/apk/unreadable carry no hash)', () => {
    const r = parseModcmpLine('{"type":"modcmp","module":"base.apk","path":"/x/base.apk","base":"0x1","pid":7,"state":"apk","mem_sha256":null,"file_sha256":null}')
    expect(r?.state).toBe('apk')
    expect(r?.memSha256).toBeNull()
    expect(r?.fileSha256).toBeNull()
  })
  it('rejects a non-modcmp line (a dump record on the same channel)', () => {
    expect(parseModcmpLine('{"type":"dump","module":"libx.so","path":"/x","base":"0x1","pid":1,"raw":false}')).toBeNull()
  })
  it('rejects an unknown state rather than trusting it', () => {
    expect(parseModcmpLine('{"type":"modcmp","module":"m","path":"p","base":"0x1","pid":1,"state":"weird","mem_sha256":null,"file_sha256":null}')).toBeNull()
  })
  it('rejects a truncated/partial device-write line without throwing', () => {
    expect(parseModcmpLine('{"type":"modcmp","module":"libx.so","pa')).toBeNull()
  })
  it('rejects a well-formed record whose type is not "modcmp" (type guard)', () => {
    // A dump record with all valid modcmp fields including a valid state
    expect(parseModcmpLine('{"type":"dump","module":"libx.so","path":"/data/app/base.apk","base":"0x7281a0000","pid":25659,"state":"match","mem_sha256":"aa","file_sha256":"bb"}')).toBeNull()
  })
  it('rejects a record with a missing required field: no path', () => {
    expect(parseModcmpLine('{"type":"modcmp","module":"libx.so","base":"0x1","pid":1,"state":"match","mem_sha256":null,"file_sha256":null}')).toBeNull()
  })
  it('rejects a record with a missing required field: no module', () => {
    expect(parseModcmpLine('{"type":"modcmp","path":"/x","base":"0x1","pid":1,"state":"match","mem_sha256":null,"file_sha256":null}')).toBeNull()
  })
  it('rejects a record with a missing required field: no base', () => {
    expect(parseModcmpLine('{"type":"modcmp","module":"libx.so","path":"/x","pid":1,"state":"match","mem_sha256":null,"file_sha256":null}')).toBeNull()
  })
  it('rejects a record with a missing required field: no pid', () => {
    expect(parseModcmpLine('{"type":"modcmp","module":"libx.so","path":"/x","base":"0x1","state":"match","mem_sha256":null,"file_sha256":null}')).toBeNull()
  })
  it('rejects a record where pid has the wrong type (string instead of number)', () => {
    expect(parseModcmpLine('{"type":"modcmp","module":"libx.so","path":"/x","base":"0x1","pid":"25659","state":"match","mem_sha256":null,"file_sha256":null}')).toBeNull()
  })
  it('rejects a record where module has the wrong type (number instead of string)', () => {
    expect(parseModcmpLine('{"type":"modcmp","module":123,"path":"/x","base":"0x1","pid":1,"state":"match","mem_sha256":null,"file_sha256":null}')).toBeNull()
  })
  it('rejects a record where path has the wrong type (number instead of string)', () => {
    expect(parseModcmpLine('{"type":"modcmp","module":"libx.so","path":456,"base":"0x1","pid":1,"state":"match","mem_sha256":null,"file_sha256":null}')).toBeNull()
  })
  it('rejects a record where base has the wrong type (number instead of string)', () => {
    expect(parseModcmpLine('{"type":"modcmp","module":"libx.so","path":"/x","base":789,"pid":1,"state":"match","mem_sha256":null,"file_sha256":null}')).toBeNull()
  })
})

describe('parseModcmpJsonl', () => {
  it('keeps only well-formed modcmp records, skips blanks and other types', () => {
    const text = [
      '{"type":"modcmp","module":"a","path":"p","base":"0x1","pid":1,"state":"match","mem_sha256":"x","file_sha256":"x"}',
      '',
      '{"type":"coverage","engine":"dump","exempt":true}',
      '{"type":"modcmp","module":"b","path":"p","base":"0x2","pid":1,"state":"differ","mem_sha256":"y","file_sha256":"z"}',
    ].join('\n')
    const rs = parseModcmpJsonl(text)
    expect(rs.map(r => r.base)).toEqual(['0x1', '0x2'])
  })
})
