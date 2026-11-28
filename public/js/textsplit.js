// 句子切分：兼容不支持正则后行断言（lookbehind）的浏览器（iOS Safari < 16.4）。
// 规则与原先的 /(?<=[.!?。！？；;])\s+(?=[A-Z"...])|(?<=[。！？；;])\s*/ 等价。

export function splitSentences(text) {
  const s = String(text || '');
  const out = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    buf += ch;
    if (!'。！？；;.!?'.includes(ch)) continue;
    // 吞掉紧跟的右引号 / 右括号，避免把 “word.” 拆开
    while (i + 1 < s.length && '"\'”’)]'.includes(s[i + 1])) buf += s[++i];
    if ('。！？；;'.includes(ch)) {
      out.push(buf);
      buf = '';
      continue;
    }
    // 英文 . ! ?：后面是空白，且空白后是大写字母 / 引号 / 括号 / 中文才断句
    let j = i + 1;
    if (j < s.length && /\s/.test(s[j])) {
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j < s.length && /[A-Z"“'(\u4e00-\u9fa5]/.test(s[j])) {
        out.push(buf);
        buf = '';
      }
    }
  }
  if (buf.trim()) out.push(buf);
  return out.map((x) => x.trim()).filter(Boolean);
}
