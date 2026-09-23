import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_FRAME = 2 * 1024 * 1024;

/** Extract complete PNG frames from ffmpeg's image2pipe output, regardless of chunk boundaries. */
export function createPngStream(onFrame: (data: string) => void) {
	let pending = Buffer.alloc(0);
	return (chunk: Buffer) => {
		pending = Buffer.concat([pending, chunk]);
		while (pending.length >= 8) {
			if (!pending.subarray(0, 8).equals(SIGNATURE)) throw new Error("Invalid PNG frame from ffmpeg.");
			let offset = 8;
			let complete = false;
			while (offset + 12 <= pending.length) {
				const size = pending.readUInt32BE(offset);
				const end = offset + 12 + size;
				if (end > MAX_FRAME) throw new Error("Video frame exceeds the 2 MB preview limit.");
				if (end > pending.length) break;
				const last = pending.toString("ascii", offset + 4, offset + 8) === "IEND";
				offset = end;
				if (last) {
					onFrame(pending.subarray(0, offset).toString("base64"));
					pending = pending.subarray(offset);
					complete = true;
					break;
				}
			}
			if (!complete) {
				if (pending.length > MAX_FRAME) throw new Error("Video frame exceeds the 2 MB preview limit.");
				break;
			}
		}
	};
}

/** Pace frames ourselves: ffmpeg's -re produces bursts and long gaps near repeated input timestamps. */
export function playVideoFrames(path: string, onFrame: (data: string) => void, onError: (error: string) => void): () => void {
	const child: ChildProcessWithoutNullStreams = spawn("ffmpeg", [
		"-nostdin", "-v", "error", "-stream_loop", "-1", "-i", path,
		"-vf", "fps=15,scale=320:180:force_original_aspect_ratio=decrease", "-an",
		"-f", "image2pipe", "-vcodec", "png", "pipe:1",
	], { stdio: ["pipe", "pipe", "pipe"] });
	const frames: string[] = [];
	const receive = createPngStream(data => { frames.push(data); if (frames.length >= 3) child.stdout.pause(); });
	let stopped = false;
	let diagnostic = "";
	const timer = setInterval(() => {
		const frame = frames.shift();
		if (frame) onFrame(frame);
		if (frames.length <= 1) child.stdout.resume();
	}, 1000 / 15);
	child.stdout.on("data", (chunk: Buffer) => {
		if (stopped) return;
		try { receive(chunk); }
		catch (error) { onError(error instanceof Error ? error.message : String(error)); stop(); }
	});
	child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-500); });
	child.on("error", (error) => { if (!stopped) { onError(error.message); stop(); } });
	child.on("close", (code) => { if (!stopped) { onError(diagnostic.trim() || `Video playback stopped (exit ${code}).`); stop(); } });
	function stop() {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		frames.length = 0;
		child.stdout.destroy();
		child.stderr.destroy();
		child.stdin.destroy();
		child.kill("SIGKILL");
	}
	return stop;
}
