import { inflateRawSync } from "node:zlib";

/**
 * 最小 zip 读取器（skillhub-integration）：零第三方依赖，只支持 SkillHub
 * 下载产物所需的 store(0)/deflate(8) 两法。安全护栏（供应链面，brief §6）：
 * - 拒绝绝对路径 / `..` 穿越 / 反斜杠 / symlink 条目
 * - 条目数与解压总字节封顶（zip bomb 护栏）
 * - 不支持 zip64（SkillHub zip 远小于 4GB，遇到即诚实报错）
 * - uncompSize 与实际解压长度不符 = 损坏，报错
 */

export type ZipEntry = { path: string; bytes: Uint8Array };

export const UNZIP_MAX_ENTRIES = 2048;
export const UNZIP_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

export class ZipFormatError extends Error {}

function u16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

function u32(buf: Uint8Array, off: number): number {
  return (
    (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
  );
}

function findEocd(buf: Uint8Array): number {
  // EOCD 在尾部，comment 最长 65535 → 从后向前扫
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (u32(buf, i) === EOCD_SIG) return i;
  }
  throw new ZipFormatError("not a zip file (EOCD not found)");
}

function assertSafePath(p: string): void {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("..")) {
    throw new ZipFormatError(`unsafe entry path: ${p}`);
  }
}

export function readZip(data: Uint8Array): ZipEntry[] {
  const eocd = findEocd(data);
  // zip64 locator 紧邻 EOCD 之前 → 不支持
  if (eocd >= 20 && u32(data, eocd - 20) === ZIP64_EOCD_LOCATOR_SIG) {
    throw new ZipFormatError("zip64 not supported");
  }
  const total = u16(data, eocd + 10);
  const cdOffset = u32(data, eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) {
    throw new ZipFormatError("zip64 not supported");
  }
  if (total > UNZIP_MAX_ENTRIES) {
    throw new ZipFormatError(`too many entries (${total} > ${UNZIP_MAX_ENTRIES})`);
  }

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  let pos = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (pos + 46 > data.length || u32(data, pos) !== CD_SIG) {
      throw new ZipFormatError(`bad central directory at entry ${i}`);
    }
    const method = u16(data, pos + 10);
    const compSize = u32(data, pos + 20);
    const uncompSize = u32(data, pos + 24);
    const nameLen = u16(data, pos + 28);
    const extraLen = u16(data, pos + 30);
    const commentLen = u16(data, pos + 32);
    const externalAttrs = u32(data, pos + 38);
    const localOffset = u32(data, pos + 42);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
      throw new ZipFormatError("zip64 not supported");
    }
    const name = Buffer.from(data.subarray(pos + 46, pos + 46 + nameLen)).toString("utf8");
    pos += 46 + nameLen + extraLen + commentLen;

    // 目录条目：只用于结构，不产文件
    if (name.endsWith("/")) continue;
    assertSafePath(name);
    // symlink（unix mode 高 16 位 S_IFLNK）拒绝——不给出链写盘的机会
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new ZipFormatError(`symlink entry rejected: ${name}`);
    }

    if (localOffset + 30 > data.length || u32(data, localOffset) !== LFH_SIG) {
      throw new ZipFormatError(`bad local header for ${name}`);
    }
    const lNameLen = u16(data, localOffset + 26);
    const lExtraLen = u16(data, localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > data.length) {
      throw new ZipFormatError(`truncated data for ${name}`);
    }
    const raw = data.subarray(dataStart, dataStart + compSize);
    let bytes: Uint8Array;
    if (method === 0) {
      bytes = Uint8Array.from(raw);
    } else if (method === 8) {
      try {
        bytes = inflateRawSync(raw, { maxOutputLength: UNZIP_MAX_TOTAL_BYTES });
      } catch (err) {
        throw new ZipFormatError(`inflate failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      throw new ZipFormatError(`unsupported compression method ${method} for ${name}`);
    }
    if (bytes.byteLength !== uncompSize) {
      throw new ZipFormatError(`size mismatch for ${name} (corrupt zip)`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > UNZIP_MAX_TOTAL_BYTES) {
      throw new ZipFormatError("uncompressed size cap exceeded (zip bomb guard)");
    }
    entries.push({ path: name, bytes });
  }
  return entries;
}
