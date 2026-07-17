/** Phosphor icon helpers for tool calls and file extensions. */

import {
  Brain, BookOpen, Terminal, MagnifyingGlass, Globe,
  FileTs, FileJs, FileCss, FileHtml, FileRs, FileSql,
  FileText, FileCode, FilePdf, FileDoc, FileXls, FilePpt, FileZip, FileImage,
  File, Eye, AppWindow,
} from "@phosphor-icons/react";

export function toolIcon(name: string): React.ReactNode {
  switch (name) {
    case "bash_tool": return <Terminal />;
    case "web_search": return <MagnifyingGlass />;
    case "web_fetch": return <Globe />;
    case "read_file": case "read_skill": return <BookOpen />;
    case "read_photo": return <FileImage />;
    case "write_file": return <FileCode />;
    case "present_files": return <Eye />;
    case "show_widget": return <AppWindow />;
    default: return <Terminal />;
  }
}

export function fileExtIcon(ext: string): React.ReactNode {
  switch (ext) {
    case "ts": case "tsx": return <FileTs />;
    case "js": case "jsx": return <FileJs />;
    case "css": case "scss": return <FileCss />;
    case "html": case "htm": return <FileHtml />;
    case "rs": return <FileRs />;
    case "sql": return <FileSql />;
    case "md": case "mdx": case "txt": return <FileText />;
    case "py": case "rb": case "go": case "java": case "kt": case "swift": case "c": case "cpp": case "h":
    case "json": case "yml": case "yaml": case "sh": case "ps1":
      return <FileCode />;
    case "pdf": return <FilePdf />;
    case "doc": case "docx": case "rtf": case "odt": return <FileDoc />;
    case "xls": case "xlsx": case "csv": case "ods": return <FileXls />;
    case "ppt": case "pptx": case "odp": return <FilePpt />;
    case "zip": case "tar": case "gz": case "skill": return <FileZip />;
    case "png": case "jpg": case "jpeg": case "gif": case "svg": case "webp": return <FileImage />;
    default: return <File />;
  }
}

/** Human-facing "kind" label for the file-card subtitle (e.g. "Code · HTML").
 *  Returns an `artifacts.kind.*` i18n key suffix. */
export function fileExtKind(ext: string): string {
  switch (ext) {
    case "ts": case "tsx": case "js": case "jsx": case "css": case "scss": case "html": case "htm":
    case "rs": case "sql": case "py": case "rb": case "go": case "java": case "kt": case "swift":
    case "c": case "cpp": case "h": case "json": case "yml": case "yaml": case "sh": case "ps1":
      return "code";
    case "pdf": return "pdf";
    case "doc": case "docx": case "rtf": case "odt": return "document";
    case "xls": case "xlsx": case "csv": case "ods": return "spreadsheet";
    case "ppt": case "pptx": case "odp": return "presentation";
    case "zip": case "tar": case "gz": case "skill": return "archive";
    case "png": case "jpg": case "jpeg": case "gif": case "svg": case "webp": return "image";
    case "md": case "mdx": case "txt": return "text";
    default: return "file";
  }
}
