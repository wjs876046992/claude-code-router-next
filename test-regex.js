const content = `<thinking>
This is some reasoning
</thinking>
This is the answer`;

const regex = /<thinking>([\s\S]*?)<\/thinking>/g;
let reasoning = "";
let cleanContent = content;

const match = regex.exec(content);
if (match) {
  reasoning = match[1].trim();
  cleanContent = content.replace(match[0], "").trim();
}

console.log("reasoning:", reasoning);
console.log("cleanContent:", cleanContent);
