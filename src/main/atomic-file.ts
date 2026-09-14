import { closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { UserError } from '../shared/validation.ts';

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function assertRegularFile(file: string): boolean {
  try {
    if (!lstatSync(file).isFile()) throw new UserError('保存先が通常のファイルではありません。既存データは変更していません。');
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

export function writeAtomic(file: string, content: string): void {
  assertRegularFile(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  let committed = false;
  try {
    try {
      writeFileSync(descriptor, content, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, file);
    committed = true;
  } finally {
    if (!committed) unlinkSync(temporary);
  }
}
