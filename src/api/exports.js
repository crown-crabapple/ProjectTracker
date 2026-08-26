/**
 * Exports: CSV, XLSX, PDF and iCal.
 *
 * All four are generated here with no dependency, which needs a word of
 * justification per format:
 *
 *   CSV   trivial, and the only hard part is quoting, which is nine lines.
 *   XLSX  a zip of XML. The writer below emits a minimal but valid workbook —
 *         no styling, one sheet, strings and numbers typed correctly. A library
 *         would add formatting nobody asked for and a supply chain nobody
 *         audited. Written with a store-only (uncompressed) zip so there is no
 *         deflate implementation to get wrong; Excel and LibreOffice both accept
 *         it.
 *   PDF   a single-page-per-chunk text document. It is deliberately plain: this
 *         is a "print the list" export, not a designed report, and pretending
 *         otherwise would need a layout engine.
 *   iCal  a text format with a folding rule. The folding rule is the only trap.
 */

'use strict';

const zlib = require('zlib');
const crypto = require('crypto');
const db = require('../db');

// -------------------------------------------------------------------------- CSV

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // A leading =, +, - or @ is a formula in a spreadsheet. Prefixing with a
  // single quote is what stops an exported subject from executing when somebody
  // opens the file.
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function toCsv(columns, rows) {
  const head = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(',')).join('\r\n');
  // The BOM is what makes Excel read it as UTF-8 rather than as the local code
  // page, which is why an accented name arrives intact.
  return '\ufeff' + head + '\r\n' + body + '\r\n';
}

// ------------------------------------------------------------------------- XLSX

/** A store-only zip. No deflate, so nothing to get wrong in the compressor. */
function zipStore(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0, 6);         // flags
    local.writeUInt16LE(0, 8);         // method 0 = stored
    local.writeUInt16LE(0, 10);        // time
    local.writeUInt16LE(0x21, 12);     // date (1 Jan 1996 — fixed, so output is reproducible)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

const xmlEscape = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // Control characters are illegal in XML 1.0 and Excel refuses the whole file
  // rather than the cell, so they are stripped here.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const colName = (n) => {
  let s = '';
  let x = n;
  while (x >= 0) { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; }
  return s;
};

function toXlsx(columns, rows, sheetName = 'Work packages') {
  const cell = (colIdx, rowIdx, value) => {
    const ref = `${colName(colIdx)}${rowIdx}`;
    if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  };
  const sheetRows = [
    `<row r="1">${columns.map((c, i) => cell(i, 1, c.label)).join('')}</row>`,
    ...rows.map((r, ri) => `<row r="${ri + 2}">${columns.map((c, i) => cell(i, ri + 2, r[c.key])).join('')}</row>`),
  ].join('');

  return zipStore([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + `<sheets><sheet name="${xmlEscape(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + `<sheetData>${sheetRows}</sheetData></worksheet>`,
    },
  ]);
}

// -------------------------------------------------------------------------- PDF

/**
 * A plain PDF: one Helvetica text stream, wrapped, paginated.
 *
 * This is the "print the list" export. It carries no colour, no chart and no
 * logo, and it says so — a report that looks designed but was assembled by
 * string concatenation is a report somebody will ask to have restyled, and there
 * is no layout engine here to restyle it with.
 */
function toPdf(title, columns, rows) {
  const LINES_PER_PAGE = 52;
  const escape = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    // WinAnsi only. A non-Latin-1 character would need an embedded font, and
    // substituting a question mark is more honest than emitting a broken glyph.
    .replace(/[^\x20-\x7e]/g, '?');

  const widths = columns.map((c) => c.width || 18);
  const line = (values) => values
    .map((v, i) => String(v === null || v === undefined ? '' : v).slice(0, widths[i]).padEnd(widths[i]))
    .join(' ');

  const allLines = [
    title,
    ''.padEnd(title.length, '='),
    '',
    line(columns.map((c) => c.label.toUpperCase())),
    line(columns.map((_, i) => ''.padEnd(widths[i], '-'))),
    ...rows.map((r) => line(columns.map((c) => r[c.key]))),
    '',
    `${rows.length} row(s). Generated by ProjectTracker. Plain text by design — this is a printed list, not a report.`,
  ];

  const pages = [];
  for (let i = 0; i < allLines.length; i += LINES_PER_PAGE) {
    pages.push(allLines.slice(i, i + LINES_PER_PAGE));
  }
  if (!pages.length) pages.push([title, '', 'nothing to export']);

  const objects = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>';
  pages.forEach((lines, i) => {
    const contentId = pageIds[i] + 1;
    objects[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] `
      + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = `BT /F1 8 Tf 30 560 Td 10 TL\n`
      + lines.map((l) => `(${escape(l)}) Tj T*`).join('\n')
      + `\nET`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objects.length; i += 1) {
    if (!objects[i]) continue;
    offsets[i] = Buffer.byteLength(pdf);
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(pdf);
  const maxId = objects.length;
  pdf += `xref\n0 ${maxId}\n0000000000 65535 f \n`;
  for (let i = 1; i < maxId; i += 1) {
    pdf += offsets[i]
      ? `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
      : '0000000000 65535 f \n';
  }
  pdf += `trailer\n<< /Size ${maxId} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// ------------------------------------------------------------------------- iCal

/**
 * An iCalendar feed.
 *
 * The folding rule is the trap: a content line longer than 75 octets must be
 * split with CRLF followed by a single space, and a reader that gets it wrong
 * silently truncates the summary. Everything else is straightforward.
 */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0;
  while (start < bytes.length) {
    const take = start === 0 ? 75 : 74;
    let end = Math.min(bytes.length, start + take);
    // Do not split a multi-byte character: back off until the next byte is not a
    // continuation byte.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    out.push((start === 0 ? '' : ' ') + bytes.slice(start, end).toString('utf8'));
    start = end;
  }
  return out.join('\r\n');
}

const icalText = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

function toIcal({ name, events }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ProjectTracker//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icalText(name)}`,
  ];
  for (const e of events) {
    // A UID must be stable across fetches or every refresh creates duplicates in
    // the subscriber's calendar. Derived from the event's identity, never random.
    const uid = crypto.createHash('sha1').update(`${e.kind}:${e.id}:${e.date}`).digest('hex');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}@projecttracker`);
    lines.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`);
    if (e.time) {
      const start = `${e.date.replace(/-/g, '')}T${e.time.replace(/:/g, '')}00`;
      lines.push(`DTSTART:${start}`);
      lines.push(`DURATION:PT${Number(e.duration_min) || 60}M`);
    } else {
      // An all-day event's DTEND is exclusive. Getting this wrong makes a
      // one-day deadline show as two days in every calendar client.
      lines.push(`DTSTART;VALUE=DATE:${e.date.replace(/-/g, '')}`);
      const next = new Date(Date.parse(e.date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
      lines.push(`DTEND;VALUE=DATE:${next.replace(/-/g, '')}`);
    }
    lines.push(`SUMMARY:${icalText(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${icalText(e.description)}`);
    if (e.url) lines.push(`URL:${icalText(e.url)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** The events behind a subscription token. */
async function icalFor(token) {
  const sub = await db.one(`
    SELECT s.*, u.name AS user_name, p.code AS project_code
      FROM calendar_subscriptions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN projects p ON p.id = s.project_id
     WHERE s.token = ? AND s.revoked_at IS NULL`, [token]);
  if (!sub) return null;
  await db.run('UPDATE calendar_subscriptions SET last_fetched_at = NOW() WHERE id = ?', [sub.id]);

  const access = require('../domain/access');
  const visible = (await access.visibleProjects(sub.user_id)).map((r) => r.id);
  const scope = sub.project_id ? [sub.project_id] : visible;
  if (!scope.length) return { name: sub.name, events: [] };
  const clause = db.inClause(scope);

  const due = await db.query(`
    SELECT wp.id, wp.wp_key, wp.subject, wp.due_date, p.code AS project_code, s.label AS status
      FROM work_packages wp JOIN projects p ON p.id = wp.project_id JOIN statuses s ON s.id = wp.status_id
     WHERE wp.project_id IN ${clause.sql} AND wp.due_date IS NOT NULL AND s.is_closed = 0`, clause.params);
  const meetings = await db.query(`
    SELECT m.id, m.title, m.scheduled_on, m.start_time, m.duration_min, p.code AS project_code
      FROM meetings m LEFT JOIN projects p ON p.id = m.project_id
     WHERE m.project_id IN ${clause.sql}`, clause.params);
  const sprints = await db.query(`
    SELECT DISTINCT s.id, s.code, s.start_date, s.end_date FROM sprints s
      LEFT JOIN sprint_projects sp ON sp.sprint_id = s.id
     WHERE s.project_id IN ${clause.sql} OR sp.project_id IN ${clause.sql} OR s.sharing = 'system'`,
  [...clause.params, ...clause.params]);

  const events = [
    ...due.map((w) => ({
      kind: 'due', id: w.id, date: w.due_date,
      summary: `${w.wp_key} ${w.subject}`,
      description: `${w.project_code} · ${w.status}`,
      url: `/#/wp/${w.id}`,
    })),
    ...meetings.map((m) => ({
      kind: 'meeting', id: m.id, date: m.scheduled_on,
      time: m.start_time ? String(m.start_time).slice(0, 5) : null,
      duration_min: m.duration_min,
      summary: m.title, description: m.project_code || '',
    })),
    ...sprints.map((s) => ({
      kind: 'sprint', id: s.id, date: s.start_date, summary: `${s.code} starts`,
    })),
  ];
  return { name: sub.name, events };
}

/** The column set every work package export shares. */
const WP_COLUMNS = [
  { key: 'key', label: 'ID', width: 8 },
  { key: 'project_code', label: 'Project', width: 8 },
  { key: 'type', label: 'Type', width: 10 },
  { key: 'subject', label: 'Subject', width: 46 },
  { key: 'status_label', label: 'Status', width: 12 },
  { key: 'priority_label', label: 'Priority', width: 10 },
  { key: 'assignee', label: 'Assignee', width: 16 },
  { key: 'accountable', label: 'Accountable', width: 16 },
  { key: 'start_date', label: 'Start', width: 11 },
  { key: 'due_date', label: 'Due', width: 11 },
  { key: 'estimated_hours', label: 'Estimate', width: 9 },
  { key: 'spent_hours', label: 'Spent', width: 9 },
  { key: 'story_points', label: 'Points', width: 7 },
  { key: 'version', label: 'Version', width: 10 },
  { key: 'sprint', label: 'Sprint', width: 8 },
];

module.exports = { toCsv, toXlsx, toPdf, toIcal, icalFor, csvCell, fold, WP_COLUMNS, zipStore, crc32 };
