/** Phosphor icon helpers for tool calls and file extensions. */

import {
  Brain, BookOpen, Terminal, MagnifyingGlass, Globe,
  FileTs, FileJs, FileCss, FileHtml, FileRs, FileSql,
  FileText, FileCode, FilePdf, FileDoc, FileXls, FilePpt, FileZip, FileImage,
  File, Eye,
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
    case "py": case "rb": case "go": case "java": case "kt": case "swift": case "c": case "cpp": case "h": return <FileCode />;
    case "pdf": return <FilePdf />;
    case "doc": case "docx": return <FileDoc />;
    case "xls": case "xlsx": case "csv": return <FileXls />;
    case "ppt": case "pptx": return <FilePpt />;
    case "zip": case "tar": case "gz": return <FileZip />;
    case "png": case "jpg": case "jpeg": case "gif": case "svg": case "webp": return <FileImage />;
    default: return <File />;
  }
}
