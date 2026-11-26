import { Check, Copy, TextCursorInput } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownMessageProps = {
  text: string;
  caret?: boolean;
  /** Roomier scale for the full-screen conversation. */
  large?: boolean;
  /** Marks block elements with their source line, so a preview can sync scroll. */
  sourceLines?: boolean;
  /** Assistant replies get Copy (and Insert, when a file is open) on code. */
  codeActions?: boolean;
  /** Puts a code block at the editor's cursor; omitted when no file is open. */
  onInsertCode?: (code: string) => void;
};

type HastNode = {
  type?: string;
  value?: string;
  children?: HastNode[];
  position?: { start: { line: number } };
};

/** The raw text of a code block, from the syntax tree rather than the DOM. */
function nodeText(node: HastNode | undefined): string {
  if (!node) {
    return "";
  }

  if (node.type === "text") {
    return node.value ?? "";
  }

  return (node.children ?? []).map(nodeText).join("");
}

function CodeBlock({
  code,
  onInsert,
  children,
  lineProps,
}: {
  code: string;
  onInsert?: (code: string) => void;
  children: ReactNode;
  lineProps: { "data-line"?: number };
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  const button =
    "flex h-6 items-center gap-1 rounded-md border border-ink/[0.08] bg-raised/90 px-1.5 text-[10px] text-ink/50 backdrop-blur transition-colors duration-150 hover:border-ink/20 hover:text-ink";

  return (
    <div {...lineProps} className="group relative mt-2 first:mt-0">
      <div className="absolute top-1.5 right-1.5 z-10 flex gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
        {onInsert && (
          <button
            type="button"
            onClick={() => onInsert(code)}
            title="Insert at the cursor in the open file"
            className={button}
          >
            <TextCursorInput className="size-3" strokeWidth={1.75} />
            Insert
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          title="Copy code"
          aria-label="Copy code"
          className={button}
        >
          {copied ? (
            <Check className="size-3" strokeWidth={2} />
          ) : (
            <Copy className="size-3" strokeWidth={1.75} />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-ink/10 bg-ink/[0.03] p-3 text-[11.5px] leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

type SourceNode = { position?: { start: { line: number } } };

const link = (children: ReactNode, href?: string) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className="text-ink/85 underline decoration-ink/30 underline-offset-2 transition hover:decoration-ink/70"
  >
    {children}
  </a>
);

/**
 * Assistant replies arrive as markdown. `react-markdown` builds React
 * elements, so model output can never inject raw HTML into the window.
 */
export default function MarkdownMessage({
  text,
  caret = false,
  large = false,
  sourceLines = false,
  codeActions = false,
  onInsertCode,
}: MarkdownMessageProps) {
  const src = (node: SourceNode | undefined) =>
    sourceLines && node?.position
      ? { "data-line": node.position.start.line }
      : {};

  return (
    <div
      className={`assistant-markdown leading-[1.65] text-ink/70 ${
        large ? "text-[13.5px]" : "text-[12.5px]"
      }`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children, node }) => (
            <h1
              {...src(node)}
              className="mt-3 mb-1.5 text-[15px] font-semibold text-ink/85 first:mt-0"
            >
              {children}
            </h1>
          ),
          h2: ({ children, node }) => (
            <h2
              {...src(node)}
              className="mt-3 mb-1.5 text-[14px] font-semibold text-ink/85 first:mt-0"
            >
              {children}
            </h2>
          ),
          h3: ({ children, node }) => (
            <h3
              {...src(node)}
              className="mt-2.5 mb-1 text-[13px] font-semibold text-ink/80 first:mt-0"
            >
              {children}
            </h3>
          ),
          h4: ({ children, node }) => (
            <h4
              {...src(node)}
              className="mt-2 mb-1 text-[12px] font-semibold uppercase tracking-[0.1em] text-ink/60 first:mt-0"
            >
              {children}
            </h4>
          ),
          p: ({ children, node }) => (
            <p {...src(node)} className="mt-2 first:mt-0">
              {children}
            </p>
          ),
          a: ({ children, href }) => link(children, href),
          strong: ({ children }) => (
            <strong className="font-semibold text-ink/85">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="italic text-ink/75">{children}</em>
          ),
          del: ({ children }) => (
            <del className="text-ink/40 line-through">{children}</del>
          ),
          ul: ({ children, node }) => (
            <ul
              {...src(node)}
              className="mt-2 list-disc space-y-1 pl-4 marker:text-ink/25 first:mt-0"
            >
              {children}
            </ul>
          ),
          ol: ({ children, node }) => (
            <ol
              {...src(node)}
              className="mt-2 list-decimal space-y-1 pl-4 marker:text-ink/25 first:mt-0"
            >
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          blockquote: ({ children, node }) => (
            <blockquote
              {...src(node)}
              className="mt-2 border-l-2 border-ink/15 pl-3 text-ink/50 first:mt-0"
            >
              {children}
            </blockquote>
          ),
          hr: ({ node }) => (
            <hr {...src(node)} className="my-3 border-ink/10" />
          ),
          code: ({ children, className }) => (
            <code
              className={`rounded bg-ink/[0.07] px-1 py-0.5 font-mono text-[11.5px] text-ink/80 ${className ?? ""}`}
            >
              {children}
            </code>
          ),
          pre: ({ children, node }) =>
            codeActions ? (
              <CodeBlock
                code={nodeText(node as HastNode).replace(/\n$/, "")}
                onInsert={onInsertCode}
                lineProps={src(node)}
              >
                {children}
              </CodeBlock>
            ) : (
            <pre
              {...src(node)}
              className="mt-2 overflow-x-auto rounded-lg border border-ink/10 bg-ink/[0.03] p-3 text-[11.5px] leading-relaxed first:mt-0"
            >
              {children}
            </pre>
          ),
          table: ({ children, node }) => (
            <div {...src(node)} className="mt-2 overflow-x-auto first:mt-0">
              <table className="w-full border-collapse text-[11.5px]">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-ink/15 px-2 py-1 text-left font-medium text-ink/70">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-ink/5 px-2 py-1 align-top">
              {children}
            </td>
          ),
          img: ({ src: imageSrc, alt }) => (
            <img
              src={imageSrc}
              alt={alt ?? ""}
              className="mt-2 max-w-full rounded"
            />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {caret && (
        <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-ink/60 align-middle" />
      )}
    </div>
  );
}
