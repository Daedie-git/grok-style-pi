// A real hook process held at an explicit filesystem barrier, never a timing delay.
const fs = require("node:fs");
const [ready, release, after, output] = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => {
	fs.writeFileSync(ready, String(process.pid));
	const timer = setInterval(() => {
		if (!fs.existsSync(release)) return;
		clearInterval(timer);
		fs.writeFileSync(after, "released");
		process.stdout.write(output);
	}, 5);
});
