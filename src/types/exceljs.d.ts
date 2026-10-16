import 'exceljs';

// @types/exceljs does not declare writeBuffer on the Xlsx facade, but the
// runtime supports it (used by src/lib/excel.ts to stream .xlsx files).
declare module 'exceljs' {
  interface Xlsx {
    writeBuffer(options?: unknown): Promise<Buffer>;
  }
}
