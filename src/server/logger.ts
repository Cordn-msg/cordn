export interface ServerLogger {
	info(bindings: Record<string, unknown>, message: string): void;
	warn(bindings: Record<string, unknown>, message: string): void;
	error(bindings: Record<string, unknown>, message: string): void;
}

export const consoleServerLogger: ServerLogger = {
	info(bindings, message) {
		console.log(message, bindings);
	},
	warn(bindings, message) {
		console.warn(message, bindings);
	},
	error(bindings, message) {
		console.error(message, bindings);
	}
};
