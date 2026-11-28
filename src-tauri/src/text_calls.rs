//! Tool calls that arrive as text.
//!
//! Many open models (and the servers that host them) do not always turn the
//! model's tool-call markup into a real `tool_calls` entry. The call then
//! shows up in the reply's text or thinking, for example as
//! `<tool_call>{"name": "write_file", ...}</tool_call>`, and the run would end
//! there with nothing done. This module finds such calls so they can run.

use serde_json::{Map, Value};

/// A call found in text: the tool's name and its arguments as a JSON object string.
#[derive(Debug, Clone, PartialEq)]
pub struct TextCall {
    pub name: String,
    pub arguments: String,
}

/// Finds the tool calls written into `text`, for the tools in `known`, and
/// returns them with the text that is left once their markup is removed.
pub fn recover(text: &str, known: &[&str]) -> (Vec<TextCall>, String) {
    let mut found: Vec<(usize, usize, Vec<TextCall>)> = Vec::new();

    tagged(text, known, &mut found);
    kimi(text, known, &mut found);
    deepseek(text, known, &mut found);
    mistral(text, known, &mut found);
    bare_function_tags(text, known, &mut found);
    bare_json(text, known, &mut found);

    found.sort_by_key(|(start, _, _)| *start);

    let mut calls = Vec::new();
    let mut rest = String::new();
    let mut cursor = 0;

    for (start, end, list) in found {
        if start < cursor {
            continue; // inside markup already taken
        }
        rest.push_str(&text[cursor..start]);
        cursor = end;
        calls.extend(list);
    }
    rest.push_str(&text[cursor..]);

    if calls.is_empty() {
        return (calls, text.to_string());
    }

    (calls, tidy(&rest))
}

/// Removes the blank lines and fences left behind by removed markup.
fn tidy(text: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    for line in text.lines() {
        let blank = line.trim().is_empty();
        if blank && lines.last().is_some_and(|last| last.trim().is_empty()) {
            continue;
        }
        lines.push(line);
    }
    let joined = lines.join("\n");
    // A fence whose JSON body was removed: ```json\n```
    let joined = joined.replace("```json\n```", "").replace("```\n```", "");
    joined.trim().to_string()
}

/// The first JSON value starting at `from`, and where it ends.
fn json_at(text: &str, from: usize) -> Option<(Value, usize)> {
    let mut stream = serde_json::Deserializer::from_str(&text[from..]).into_iter::<Value>();
    let value = stream.next()?.ok()?;
    Some((value, from + stream.byte_offset()))
}

/// Reads `{"name": ..., "arguments": ...}` and the common variants of it.
fn call_from_json(value: &Value, known: &[&str]) -> Option<TextCall> {
    let object = value.as_object()?;

    // {"type": "function", "function": {"name": ..., "arguments": ...}}
    if let Some(inner) = object.get("function").filter(|inner| inner.is_object()) {
        return call_from_json(inner, known);
    }

    let name = ["name", "tool", "tool_name", "function"]
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))?;
    let name = name.trim().trim_start_matches("functions.");
    if !known.contains(&name) {
        return None;
    }

    let arguments = ["arguments", "parameters", "args", "input"]
        .iter()
        .find_map(|key| object.get(*key));
    let arguments = match arguments {
        Some(Value::Object(map)) => Value::Object(map.clone()).to_string(),
        Some(Value::String(text)) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => Value::Object(map).to_string(),
            _ => return None,
        },
        None | Some(Value::Null) => "{}".to_string(),
        Some(_) => return None,
    };

    Some(TextCall { name: name.to_string(), arguments })
}

fn calls_from_json(value: &Value, known: &[&str]) -> Vec<TextCall> {
    match value {
        Value::Array(items) => items.iter().filter_map(|item| call_from_json(item, known)).collect(),
        other => call_from_json(other, known).into_iter().collect(),
    }
}

/// `<tool_call>…</tool_call>` (Hermes, Qwen and many fine-tunes), holding
/// JSON or `<function=…>` tags. A missing closing tag at the end is tolerated.
fn tagged(text: &str, known: &[&str], found: &mut Vec<(usize, usize, Vec<TextCall>)>) {
    for (open, close) in [("<tool_call>", "</tool_call>"), ("<function_call>", "</function_call>")] {
        let mut from = 0;
        while let Some(offset) = text[from..].find(open) {
            let start = from + offset;
            let body_start = start + open.len();
            let (body_end, end) = match text[body_start..].find(close) {
                Some(position) => (body_start + position, body_start + position + close.len()),
                None => (text.len(), text.len()),
            };
            let body = &text[body_start..body_end];

            let mut calls = Vec::new();
            if let Some(brace) = body.find(['{', '[']) {
                if let Some((value, _)) = json_at(body, brace) {
                    calls = calls_from_json(&value, known);
                }
            }
            if calls.is_empty() {
                calls = function_tags(body, known).into_iter().map(|(_, _, call)| call).collect();
            }

            if !calls.is_empty() {
                found.push((start, end, calls));
            }
            from = end.max(body_start);
        }
    }
}

/// `<function=write_file><parameter=path>a.txt</parameter>…</function>`
/// (Qwen3-Coder), as `(start, end, call)` within `text`.
fn function_tags(text: &str, known: &[&str]) -> Vec<(usize, usize, TextCall)> {
    let mut calls = Vec::new();
    let mut from = 0;

    while let Some(offset) = text[from..].find("<function=") {
        let start = from + offset;
        let name_start = start + "<function=".len();
        let Some(name_len) = text[name_start..].find('>') else { break };
        let name = text[name_start..name_start + name_len].trim().to_string();
        let body_start = name_start + name_len + 1;
        let (body_end, end) = match text[body_start..].find("</function>") {
            Some(position) => (body_start + position, body_start + position + "</function>".len()),
            None => (text.len(), text.len()),
        };
        from = end.max(body_start);

        if !known.contains(&name.as_str()) {
            continue;
        }

        let body = &text[body_start..body_end];
        let mut arguments = Map::new();
        let mut cursor = 0;
        while let Some(offset) = body[cursor..].find("<parameter=") {
            let key_start = cursor + offset + "<parameter=".len();
            let Some(key_len) = body[key_start..].find('>') else { break };
            let key = body[key_start..key_start + key_len].trim().to_string();
            let value_start = key_start + key_len + 1;
            let value_end = body[value_start..]
                .find("</parameter>")
                .map(|position| value_start + position)
                .or_else(|| body[value_start..].find("<parameter=").map(|position| value_start + position))
                .unwrap_or(body.len());
            let raw = &body[value_start..value_end];
            // One newline after the tag and before the closing tag is layout.
            let raw = raw.strip_prefix('\n').unwrap_or(raw);
            let raw = raw.strip_suffix('\n').unwrap_or(raw);
            let value = match serde_json::from_str::<Value>(raw.trim()) {
                Ok(parsed @ (Value::Number(_) | Value::Bool(_) | Value::Array(_) | Value::Object(_))) => parsed,
                _ => Value::String(raw.to_string()),
            };
            arguments.insert(key, value);
            cursor = (value_end + "</parameter>".len()).min(body.len());
        }

        calls.push((
            start,
            end,
            TextCall { name, arguments: Value::Object(arguments).to_string() },
        ));
    }

    calls
}

/// `<function=…>` tags written without a `<tool_call>` around them.
fn bare_function_tags(text: &str, known: &[&str], found: &mut Vec<(usize, usize, Vec<TextCall>)>) {
    for (start, end, call) in function_tags(text, known) {
        found.push((start, end, vec![call]));
    }
}

/// Kimi: `<|tool_call_begin|>functions.write_file:0<|tool_call_argument_begin|>{…}<|tool_call_end|>`.
fn kimi(text: &str, known: &[&str], found: &mut Vec<(usize, usize, Vec<TextCall>)>) {
    const BEGIN: &str = "<|tool_call_begin|>";
    const ARGS: &str = "<|tool_call_argument_begin|>";
    const END: &str = "<|tool_call_end|>";

    let mut from = 0;
    while let Some(offset) = text[from..].find(BEGIN) {
        let start = from + offset;
        let head_start = start + BEGIN.len();
        let Some(args_offset) = text[head_start..].find(ARGS) else { break };
        let head = &text[head_start..head_start + args_offset];
        let name = head.trim().trim_start_matches("functions.");
        let name = name.split(':').next().unwrap_or("").trim().to_string();
        let json_start = head_start + args_offset + ARGS.len();
        let Some((value, json_end)) = json_at(text, json_start) else {
            from = json_start;
            continue;
        };
        let end = text[json_end..]
            .find(END)
            .filter(|position| text[json_end..json_end + position].trim().is_empty())
            .map(|position| json_end + position + END.len())
            .unwrap_or(json_end);
        from = end;

        if known.contains(&name.as_str()) && value.is_object() {
            found.push((start, end, vec![TextCall { name, arguments: value.to_string() }]));
        }
    }

    // The section markers around the calls carry nothing.
    for marker in ["<|tool_calls_section_begin|>", "<|tool_calls_section_end|>"] {
        let mut from = 0;
        while let Some(offset) = text[from..].find(marker) {
            let start = from + offset;
            found.push((start, start + marker.len(), Vec::new()));
            from = start + marker.len();
        }
    }
}

/// DeepSeek: `<｜tool▁call▁begin｜>function<｜tool▁sep｜>write_file\n```json\n{…}\n```<｜tool▁call▁end｜>`.
fn deepseek(text: &str, known: &[&str], found: &mut Vec<(usize, usize, Vec<TextCall>)>) {
    const BEGIN: &str = "<｜tool▁call▁begin｜>";
    const SEP: &str = "<｜tool▁sep｜>";
    const END: &str = "<｜tool▁call▁end｜>";

    let mut from = 0;
    while let Some(offset) = text[from..].find(BEGIN) {
        let start = from + offset;
        let Some(sep) = text[start..].find(SEP).map(|position| start + position + SEP.len()) else { break };
        let name_end = text[sep..].find(['\n', '{', '`']).map(|position| sep + position).unwrap_or(text.len());
        let name = text[sep..name_end].trim().to_string();
        let Some(brace) = text[name_end..].find('{').map(|position| name_end + position) else { break };
        let Some((value, json_end)) = json_at(text, brace) else {
            from = brace + 1;
            continue;
        };
        let end = text[json_end..].find(END).map(|position| json_end + position + END.len()).unwrap_or(json_end);
        from = end;

        if known.contains(&name.as_str()) && value.is_object() {
            found.push((start, end, vec![TextCall { name, arguments: value.to_string() }]));
        }
    }

    for marker in ["<｜tool▁calls▁begin｜>", "<｜tool▁calls▁end｜>"] {
        let mut from = 0;
        while let Some(offset) = text[from..].find(marker) {
            let start = from + offset;
            found.push((start, start + marker.len(), Vec::new()));
            from = start + marker.len();
        }
    }
}

/// Mistral: `[TOOL_CALLS][{"name": …, "arguments": …}]` or `[TOOL_CALLS]write_file[ARGS]{…}`.
fn mistral(text: &str, known: &[&str], found: &mut Vec<(usize, usize, Vec<TextCall>)>) {
    const MARK: &str = "[TOOL_CALLS]";
    let mut from = 0;

    while let Some(offset) = text[from..].find(MARK) {
        let start = from + offset;
        let after = start + MARK.len();
        from = after;

        let trimmed = after + (text[after..].len() - text[after..].trim_start().len());
        if text[trimmed..].starts_with(['[', '{']) {
            if let Some((value, end)) = json_at(text, trimmed) {
                let calls = calls_from_json(&value, known);
                if !calls.is_empty() {
                    found.push((start, end, calls));
                    from = end;
                }
            }
            continue;
        }

        if let Some(args) = text[after..].find("[ARGS]") {
            let name = text[after..after + args].trim().to_string();
            let json_start = after + args + "[ARGS]".len();
            if let Some((value, end)) = json_at(text, json_start) {
                if known.contains(&name.as_str()) && value.is_object() {
                    found.push((start, end, vec![TextCall { name, arguments: value.to_string() }]));
                    from = end;
                }
            }
        }
    }
}

/// A JSON call written on its own, often in a ```json fence. Only objects
/// that name a known tool count, so ordinary JSON in an answer is left alone.
fn bare_json(text: &str, known: &[&str], found: &mut Vec<(usize, usize, Vec<TextCall>)>) {
    let mut from = 0;

    while let Some(offset) = text[from..].find(['{', '[']) {
        let start = from + offset;
        // Only where a value could begin a line or follow a fence or colon.
        let before = text[..start].trim_end_matches([' ', '\t']);
        let line_start = before.is_empty() || before.ends_with('\n') || before.ends_with(':');
        if !line_start {
            from = start + 1;
            continue;
        }

        let Some((value, end)) = json_at(text, start) else {
            from = start + 1;
            continue;
        };
        let calls = calls_from_json(&value, known);
        if calls.is_empty() {
            from = end.max(start + 1);
            continue;
        }

        // Take the fence around it as well.
        let mut cut_start = start;
        let mut cut_end = end;
        let head = text[..start].trim_end();
        for fence in ["```json", "```JSON", "```tool_call", "```"] {
            if head.ends_with(fence) {
                cut_start = head.len() - fence.len();
                break;
            }
        }
        let tail = &text[end..];
        let tail_trimmed = tail.trim_start();
        if cut_start != start && tail_trimmed.starts_with("```") {
            cut_end = end + (tail.len() - tail_trimmed.len()) + 3;
        }

        found.push((cut_start, cut_end, calls));
        from = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN: [&str; 4] = ["write_file", "read_file", "list_files", "edit_file"];

    fn args(call: &TextCall) -> Value {
        serde_json::from_str(&call.arguments).unwrap()
    }

    #[test]
    fn hermes_tags() {
        let text = "I'll create it now.\n<tool_call>\n{\"name\": \"write_file\", \"arguments\": {\"path\": \"index.html\", \"content\": \"<h1>Hi</h1>\"}}\n</tool_call>";
        let (calls, rest) = recover(text, &KNOWN);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "write_file");
        assert_eq!(args(&calls[0])["path"], "index.html");
        assert_eq!(rest, "I'll create it now.");
    }

    #[test]
    fn unclosed_tag_and_string_arguments() {
        let text = "<tool_call>{\"name\": \"list_files\", \"arguments\": \"{\\\"path\\\": \\\"\\\"}\"}";
        let (calls, rest) = recover(text, &KNOWN);
        assert_eq!(calls.len(), 1);
        assert_eq!(args(&calls[0])["path"], "");
        assert_eq!(rest, "");
    }

    #[test]
    fn qwen_coder_function_tags() {
        let text = "<tool_call>\n<function=write_file>\n<parameter=path>\nsite/index.html\n</parameter>\n<parameter=content>\n<!doctype html>\n<p>x</p>\n</parameter>\n</function>\n</tool_call>";
        let (calls, _) = recover(text, &KNOWN);
        assert_eq!(calls.len(), 1);
        let a = args(&calls[0]);
        assert_eq!(a["path"], "site/index.html");
        assert_eq!(a["content"], "<!doctype html>\n<p>x</p>");

        let (bare, _) = recover("<function=read_file><parameter=path>a.rs</parameter></function>", &KNOWN);
        assert_eq!(args(&bare[0])["path"], "a.rs");
    }

    #[test]
    fn kimi_deepseek_mistral() {
        let kimi = "<|tool_calls_section_begin|><|tool_call_begin|>functions.read_file:0<|tool_call_argument_begin|>{\"path\": \"a.txt\"}<|tool_call_end|><|tool_calls_section_end|>";
        let (calls, rest) = recover(kimi, &KNOWN);
        assert_eq!(calls, vec![TextCall { name: "read_file".into(), arguments: "{\"path\":\"a.txt\"}".into() }]);
        assert_eq!(rest, "");

        let deepseek = "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>list_files\n```json\n{\"path\": \"src\"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>";
        let (calls, _) = recover(deepseek, &KNOWN);
        assert_eq!(calls[0].name, "list_files");
        assert_eq!(args(&calls[0])["path"], "src");

        let (calls, _) = recover("[TOOL_CALLS][{\"name\": \"read_file\", \"arguments\": {\"path\": \"b\"}}]", &KNOWN);
        assert_eq!(args(&calls[0])["path"], "b");
        let (calls, _) = recover("[TOOL_CALLS]read_file[ARGS]{\"path\": \"c\"}", &KNOWN);
        assert_eq!(args(&calls[0])["path"], "c");
    }

    #[test]
    fn fenced_json_call() {
        let text = "Creating the page:\n```json\n{\"name\": \"write_file\", \"parameters\": {\"path\": \"a.html\", \"content\": \"x\"}}\n```\nDone soon.";
        let (calls, rest) = recover(text, &KNOWN);
        assert_eq!(calls.len(), 1);
        assert_eq!(rest, "Creating the page:\n\nDone soon.");

        let wrapped = "{\"type\": \"function\", \"function\": {\"name\": \"read_file\", \"arguments\": {\"path\": \"z\"}}}";
        assert_eq!(recover(wrapped, &KNOWN).0.len(), 1);
    }

    #[test]
    fn ordinary_text_is_left_alone() {
        for text in [
            "Here is the config:\n```json\n{\"name\": \"nexium\", \"version\": \"1.0.0\"}\n```",
            "Call `write_file` with a path and content.",
            "{\"name\": \"delete_everything\", \"arguments\": {}}",
            "The object {\"name\": \"write_file\"} in a sentence.",
        ] {
            let (calls, rest) = recover(text, &KNOWN);
            assert!(calls.is_empty(), "{text}");
            assert_eq!(rest, text);
        }
    }
}
