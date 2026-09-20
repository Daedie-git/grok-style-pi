import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Image, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent, type Component } from "@earendil-works/pi-tui";
import type { ImagePreview } from "./diamond.ts";

type Theme = { fg: (token: any, text: string) => string; bg?: (token: any, text: string) => string };
type Hit = { y: number; x: number; end: number; action: () => void };
export type ConvertImage = (data: string, mimeType: string) => Promise<{ data: string; mimeType: string } | null>;

/** A bordered viewer that shows a tool-result image as large as the terminal allows. */
export class ImageViewer {
	private index = 0;
	private imageKey = "";
	private image: Image | undefined;
	private hits: Hit[] = [];
	private images: ImagePreview[];
	private title: string;
	private theme: Theme;
	private rows: () => number;
	private redraw: () => void;
	private close: () => void;
	constructor(images: ImagePreview[], title: string, theme: Theme, rows: () => number, redraw: () => void, close: () => void) {
		this.images = images;
		this.title = title;
		this.theme = theme;
		this.rows = rows;
		this.redraw = redraw;
		this.close = close;
	}
	invalidate() { this.image?.invalidate(); this.imageKey = ""; }
	render(width: number): string[] {
		this.hits = [];
		if (width <= 0) return [];
		if (width < 4) {
			this.hits.push({ y: 0, x: 0, end: width, action: this.close });
			return [truncateToWidth("×", width, "")];
		}
		const inner = width - 2;
		const inset = inner >= 4 ? 1 : 0;
		const contentWidth = inner - inset * 2;
		const maxHeight = Math.max(3, Math.floor(this.rows() * 0.85));
		const border = (text: string) => this.theme.fg("borderAccent", text);
		const frame = (text: string) => {
			const clipped = truncateToWidth(text, contentWidth, "");
			return border("│") + " ".repeat(inset) + clipped + " ".repeat(contentWidth - visibleWidth(clipped) + inset) + border("│");
		};
		const closeLabel = contentWidth >= 7 ? "[Close]" : contentWidth >= 3 ? "[x]" : "×";
		const count = this.images.length > 1 ? ` · ${this.index + 1}/${this.images.length}` : "";
		const titleWidth = Math.max(0, contentWidth - closeLabel.length - 1);
		const title = truncateToWidth(`${this.title.replace(/\s+/g, " ").trim()}${count}`, titleWidth, "…");
		const closeX = 1 + inset + contentWidth - visibleWidth(closeLabel);
		this.hits.push({ y: 1, x: closeX, end: closeX + visibleWidth(closeLabel), action: this.close });
		const lines = [
			border("╭" + "─".repeat(inner) + "╮"),
			frame(this.theme.fg("accent", title) + " ".repeat(Math.max(0, contentWidth - visibleWidth(title) - visibleWidth(closeLabel))) + this.theme.fg("accent", closeLabel)),
		];
		const chrome = 6;
		if (maxHeight >= chrome) {
			lines.push(border("├" + "─".repeat(inner) + "┤"));
			const imageHeight = Math.max(1, maxHeight - chrome);
			const current = this.images[this.index] ?? this.images[0]!;
			const key = `${this.index}:${contentWidth}x${imageHeight}:${current.mimeType}:${current.data.length}`;
			if (!this.image || this.imageKey !== key) {
				this.image = new Image(current.data, current.mimeType, { fallbackColor: (text) => this.theme.fg("toolOutput", text) }, {
					maxWidthCells: Math.max(1, contentWidth),
					maxHeightCells: imageHeight,
					filename: this.title,
				});
				this.imageKey = key;
			}
			for (const line of this.image.render(contentWidth).slice(0, imageHeight)) lines.push(frame(line));
			lines.push(border("├" + "─".repeat(inner) + "┤"));
			const y = lines.length;
			if (contentWidth >= 12) this.hits.push({ y, x: 1 + inset, end: 1 + inset + 12, action: this.close });
			const extra = this.images.length > 1 ? this.theme.fg("muted", "  ← → next") : "";
			lines.push(frame(this.theme.fg("accent", "[Close: Esc]") + extra));
		}
		lines.push(border("╰" + "─".repeat(inner) + "╯"));
		return this.theme.bg ? lines.map((line) => this.theme.bg!("toolPendingBg", line)) : lines;
	}
	handleInput(data: string) {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) return this.close();
		if (this.images.length < 2) return;
		if (matchesKey(data, "left")) this.index = (this.index + this.images.length - 1) % this.images.length;
		else if (matchesKey(data, "right")) this.index = (this.index + 1) % this.images.length;
		else return;
		this.redraw();
	}
	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const hit = this.hits.find((hit) => event.y === hit.y && event.x >= hit.x && event.x < hit.end);
		if (!hit) return undefined;
		hit.action();
		return { handled: true };
	}
}

/** Decorate public component methods on inline images; keep native child identity intact. */
export function bindInlineImages(root: Component, view: (images: ImagePreview[], title: string) => void, hidden: () => boolean) {
	const bound = new Map<Image, { render: Image["render"]; mouse: Component["handleMouse"] }>();
	function restore(image: Image, original: { render: Image["render"]; mouse: Component["handleMouse"] }) {
		image.render = original.render;
		const component = image as Component;
		if (original.mouse) component.handleMouse = original.mouse;
		else delete component.handleMouse;
	}
	return {
		scan() {
			const seen = new Set<Image>();
			let changed = false;
			function visit(component: Component) {
				if (component instanceof Image) {
					const image = component;
					seen.add(image);
					if (bound.has(image)) return;
					const original = { render: image.render, mouse: (image as Component).handleMouse };
					bound.set(image, original);
					image.render = width => { const lines = original.render.call(image, width); return hidden() ? lines.map(() => "") : lines; };
					(image as Component).handleMouse = event => {
						if (!hidden() && event.button === "left") {
							if (event.type === "press") return { handled: true };
							if (event.type === "click") {
								const data = image as unknown as { base64Data: string; mimeType: string; options: { filename?: string } };
								if (data.base64Data && data.mimeType) {
									view([{ data: data.base64Data, mimeType: data.mimeType }], data.options.filename || "Image");
									return { handled: true };
								}
							}
						}
						return original.mouse?.call(image, event);
					};
					changed = true;
					return;
				}
				const children = (component as Component & { children?: Component[] }).children;
				if (Array.isArray(children)) children.forEach(visit);
			}
			visit(root);
			for (const [image, original] of bound) if (!seen.has(image)) { restore(image, original); bound.delete(image); }
			return changed;
		},
		dispose() { for (const [image, original] of bound) restore(image, original); bound.clear(); },
	};
}

export function installImageViewer(pi: Pick<ExtensionAPI, "on">, convert?: ConvertImage) {
	let ctx: ExtensionContext | undefined;
	let closeViewer: (() => void) | undefined;
	let opening = false;
	let binding: ReturnType<typeof bindInlineImages> | undefined;
	let refresh: (() => void) | undefined;
	let generation = 0;
	function cleanup() {
		generation++;
		opening = false;
		closeViewer?.();
		closeViewer = undefined;
		binding?.dispose();
		binding = undefined;
		ctx?.ui.setWidget("grok-image-clicks", undefined);
		ctx = undefined;
	}
	pi.on("session_start", (_event, context) => {
		cleanup();
		if (context.mode !== "tui") return;
		ctx = context;
		ctx.ui.setWidget("grok-image-clicks", (tui) => {
			refresh = () => { tui.invalidate(); tui.requestRender(true); };
			binding = bindInlineImages(tui, (images, title) => { void controller.view(images, title); }, () => !!closeViewer);
			return { invalidate() {}, render() { if (binding?.scan()) tui.requestRender(); return []; } };
		});
	});
	pi.on("session_shutdown", cleanup);
	async function prepare(images: ImagePreview[]): Promise<ImagePreview[]> {
		if (!convert) return images;
		const prepared: ImagePreview[] = [];
		for (const image of images) {
			if (image.mimeType === "image/png") { prepared.push(image); continue; }
			prepared.push(await convert(image.data, image.mimeType) ?? image);
		}
		return prepared;
	}
	const controller = {
		async view(images: ImagePreview[], title: string) {
			if (!ctx || closeViewer || opening || !images.length || typeof ctx.ui.custom !== "function") return;
			const version = generation;
			opening = true;
			try {
				const prepared = await prepare(images);
				if (version !== generation || !ctx || closeViewer || !prepared.length) return;
				await ctx.ui.custom<void>((tui, theme, _keys, done) => {
					closeViewer = () => { closeViewer = undefined; done(); refresh?.(); };
					refresh?.();
					return new ImageViewer(prepared, title, theme, () => tui.terminal.rows, () => tui.requestRender(), closeViewer);
				}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } });
			} catch (error) {
				if (version === generation) ctx?.ui.notify?.(error instanceof Error ? error.message : String(error), "error");
			} finally {
				if (version === generation) { opening = false; closeViewer = undefined; refresh?.(); }
			}
		},
	};
	return controller;
}
