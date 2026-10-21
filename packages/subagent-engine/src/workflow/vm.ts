import { createContext, Script } from "node:vm";
import { compileBody, instrumentBody } from "./compile.ts";
import { performance } from "node:perf_hooks";

/** Capability-limited same-process realm, not an operating-system sandbox. */
export async function runInRealm(input: { body: string; globals: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
	const compiled = compileBody(input.body);
	if (!compiled.ok) throw new SyntaxError(compiled.error);
	if (input.signal?.aborted) throw new Error("Workflow aborted");
	const timeout = input.timeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeout) || timeout < 1) throw new RangeError("Invalid workflow synchronous timeout");
	const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
	let deadline = performance.now() + timeout;
	const timers = new Map<number, ReturnType<typeof setTimeout>>();
	let nextTimer = 0, ended = false;
	let resolveResult!: (value: unknown) => void, rejectResult!: (error: Error) => void;
	const result = new Promise<unknown>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
	const fail = (error: unknown) => {
		if (ended) return;
		rejectResult(new Error(error instanceof Error ? error.message : String(error)));
	};
	const encode = (value: unknown): string => JSON.stringify(value === undefined ? { kind: "undefined" } : value === Infinity ? { kind: "infinity" } : { kind: "value", value });
	const errorText = (error: unknown): string => {
		try { return error && typeof error === "object" && "message" in error ? String(error.message) : String(error); } catch { return "Workflow capability failed"; }
	};
	const run = (source: string) => new Script(source, { filename: "workflow.js" }).runInContext(context, { timeout });
	function checkIntake(value: unknown, seen = new Set<object>()): void {
		if (!value || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value) && value.length > 4096) throw new Error("Workflow arrays are limited to 4096 elements");
		for (const entry of Object.values(value)) checkIntake(entry, seen);
	}
	const bridge = {
		reset() { deadline = performance.now() + timeout; },
		check() { return performance.now() <= deadline; },
		aborted() { return input.signal?.aborted === true; },
		invoke(name: string, args: unknown[], resolve: (encoded: string) => void, reject: (error: string) => void) {
			// Only encoded data, never a host Promise/object/error, returns to the realm.
			let invoked: unknown;
			try {
				if (input.signal?.aborted && name === "agent") return;
				if (ended || input.signal?.aborted) throw new Error("Workflow aborted");
				checkIntake(args);
				invoked = (input.globals[name] as (...values: unknown[]) => unknown)(...structuredClone(args));
			} catch (error) { reject(errorText(error)); return; }
			void Promise.resolve(invoked).then(value => { bridge.reset(); resolve(encode(value)); }, error => { bridge.reset(); reject(errorText(error)); }).catch(fail);
		},
		sync(name: string, args: unknown[]): string {
			try { checkIntake(args); return encode((input.globals[name] as (...values: unknown[]) => unknown)(...structuredClone(args))); }
			catch (error) { return JSON.stringify({ kind: "error", value: errorText(error) }); }
		},
		budget(name: "spent" | "remaining"): string {
			try { return encode((input.globals.budget as { spent(): number; remaining(): number })[name]()); }
			catch (error) { return JSON.stringify({ kind: "error", value: errorText(error) }); }
		},
		timer(callback: () => void, delay: number): number {
			const id = ++nextTimer;
			const timer = setTimeout(() => {
				timers.delete(id);
				if (ended) return;
				bridge.reset();
				context.__workflow$timerCallback = callback;
				try { run("Promise.resolve(__workflow$timerCallback()).catch(__workflow$timerFailure)"); }
				catch (error) { fail(error); }
				finally { delete context.__workflow$timerCallback; }
			}, Math.max(0, Math.min(Number(delay) || 0, 2_147_483_647)));
			timers.set(id, timer);
			return id;
		},
		clear(id: number) { const timer = timers.get(id); if (timer) clearTimeout(timer); timers.delete(id); },
		finish(value: unknown) {
			try {
				if (typeof value === "function") throw new Error("Workflow cannot return a function");
				resolveResult(structuredClone(value));
			} catch (error) { fail(error); }
		},
		failure(error: unknown) { fail(errorText(error)); },
	};
	context.__workflow$bridge = bridge;
	const budgetTotal = (input.globals.budget as { total?: number | null } | undefined)?.total ?? null;
	const asyncNames = Object.keys(input.globals).filter(name => typeof input.globals[name] === "function" && !["log", "phase", "__workflow$failure", "__workflow$admit"].includes(name));
	const syncNames = Object.keys(input.globals).filter(name => typeof input.globals[name] === "function" && !asyncNames.includes(name));
	const data = Object.fromEntries(Object.entries(input.globals).filter(([name, value]) => name !== "budget" && typeof value !== "function"));
	const bootstrap = `(() => {
		const bridge = globalThis.__workflow$bridge; delete globalThis.__workflow$bridge;
		const __workflow$check = () => {if(!bridge.check()) throw new Error('Workflow synchronous execution timed out');};
		const __workflow$await = async value => {try{return await value;}finally{bridge.reset();}};
		const decode = text => { const entry = JSON.parse(text); if(entry.kind === 'error') throw new Error(entry.value); return entry.kind === 'undefined' ? undefined : entry.kind === 'infinity' ? Infinity : entry.value; };
		globalThis.args = undefined;
		Object.assign(globalThis, JSON.parse(${JSON.stringify(JSON.stringify(data))}));
		for (const name of ${JSON.stringify(asyncNames)}) globalThis[name] = (...args) => {
			const promise = new Promise((resolve, reject) => bridge.invoke(name, args, text => {try {resolve(decode(text));} catch(e) {reject(e);}}, message => reject(new Error(message))));
			promise.catch(() => {}); return promise;
		};
		for (const name of ${JSON.stringify(syncNames)}) globalThis[name] = (...args) => decode(bridge.sync(name,args));
		globalThis.budget = Object.freeze({total:${JSON.stringify(budgetTotal)}, spent:() => decode(bridge.budget('spent')), remaining:() => decode(bridge.budget('remaining'))});
		globalThis.setTimeout = (callback, delay, ...args) => {if(typeof callback !== 'function') throw new TypeError('Timer callback must be a function'); return bridge.timer(() => callback(...args),Number(delay));};
		globalThis.clearTimeout = id => bridge.clear(Number(id));
		const record = globalThis.__workflow$failure || (() => {}), admit = globalThis.__workflow$admit || (() => {});
		delete globalThis.__workflow$failure; delete globalThis.__workflow$admit;
		const capped = values => { if(!Array.isArray(values)) throw new TypeError('Expected an array'); if(values.length>4096) throw new RangeError('Workflow arrays are limited to 4096 elements'); return Array.from(values); };
		const collect = async slots => (await Promise.allSettled(slots)).map((slot,index) => {if(slot.status==='fulfilled') return slot.value; record(index,String(slot.reason && slot.reason.message || slot.reason)); return null;});
		globalThis.parallel = async callbacks => {
			if(bridge.aborted()) return new Promise(()=>{}); await Promise.resolve();
			const list = capped(callbacks); if(!list.length) return []; admit();
			if(!list.every(fn=>typeof fn==='function')) throw new TypeError('parallel requires callbacks');
			return collect(list.map(fn=>Promise.resolve().then(fn)));
		};
		globalThis.pipeline = async (items,...stages) => {
			if(bridge.aborted()) return new Promise(()=>{}); await Promise.resolve();
			const list=capped(items); capped(stages); if(!list.length) return []; admit();
			if(!stages.every(fn=>typeof fn==='function')) throw new TypeError('pipeline stages must be functions');
			return collect(list.map(async(original,index)=>{let current=await original; for(const stage of stages){if(current===null) break; current=await stage(current,original,index);} return current;}));
		};
		globalThis.console=Object.freeze(Object.fromEntries(['log','info','debug','warn','error'].map(name=>[name,(...args)=>globalThis.log(args.map(String).join(' '))])));
		const NativeDate=Date; const deterministicDate=new Proxy(NativeDate,{
			apply(target,self,args){if(!args.length) throw new Error('Current time is unavailable'); return new target(...args).toString();},
			construct(target,args,newTarget){if(!args.length) throw new Error('Current time is unavailable'); return Reflect.construct(target,args,newTarget);},
			get(target,key,receiver){if(key==='now') return () => {throw new Error('Current time is unavailable');}; return Reflect.get(target,key,receiver);}
		});
		Date=deterministicDate; Object.defineProperty(NativeDate.prototype,'constructor',{value:deterministicDate});
		Math.random=()=>{throw new Error('Randomness is unavailable');};
		for(const name of ['WebAssembly','ShadowRealm','FinalizationRegistry','WeakRef','Atomics','SharedArrayBuffer','queueMicrotask']) delete globalThis[name];
		for(const value of [Object,Array,Function,Promise,Error,Number,String,Boolean,RegExp,Map,Set]){Object.freeze(value.prototype);Object.freeze(value);}
		globalThis.__workflow$timerFailure = error => bridge.failure(error);
		return (async function(){'use strict';\n${instrumentBody(input.body)}\n})().then(value=>bridge.finish(value),error=>bridge.failure(error));
	})()`;
	const onAbort = () => fail("Workflow aborted");
	input.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		run(bootstrap);
		return await result;
	} finally {
		ended = true;
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
		input.signal?.removeEventListener("abort", onAbort);
	}
}
