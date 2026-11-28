const button = document.getElementById("greet");
const output = document.getElementById("output");

button.addEventListener("click", () => {
  output.textContent = `Hello from {{title}}! It is ${new Date().toLocaleTimeString()}.`;
});
