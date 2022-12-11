import { RequestsCancelData, StorageOptionsChangeData } from '@common/Events';
import { RateLimit, RequestDetails, RequestPriority, Requests } from '@common/Requests';
import { Shared } from '@common/Shared';
import { getServices } from '@models/Service';
import browser, { WebRequest as WebExtWebRequest } from 'webextension-polyfill';

export interface RequestsQueue {
	id: string;
	items: RequestsQueueItem[];
	isRunning: boolean;
	lastRequestAtMs: number;
}

export interface RequestsQueueItem {
	request: RequestDetails;
	tabId: number | null;
	rateLimit: RateLimit;
	priority: RequestPriority;
	addedAtMs: number;
	promiseResolve: (value: string) => void;
	promiseReject: (err: unknown) => void;
}

class _RequestsManager {
	queue: Record<string, RequestsQueue> = {};
	abortControllers = new Map<string, AbortController>();

	init() {
		if (Shared.pageType === 'background') {
			this.checkWebRequestListener();
			this.checkTabListener();
			Shared.events.subscribe('STORAGE_OPTIONS_CHANGE', null, this.onStorageOptionsChange);
		}
		Shared.events.subscribe('REQUESTS_CANCEL', null, this.onRequestsCancel);
	}

	onStorageOptionsChange = (data: StorageOptionsChangeData) => {
		if (data.options && 'grantCookies' in data.options) {
			this.checkWebRequestListener();
		}
	};

	checkWebRequestListener() {
		if (!browser.webRequest) {
			return;
		}

		const { grantCookies } = Shared.storage.options;
		if (
			grantCookies &&
			!browser.webRequest.onBeforeSendHeaders.hasListener(this.onBeforeSendHeaders)
		) {
			const filters: WebExtWebRequest.RequestFilter = {
				types: ['xmlhttprequest'],
				urls: [
					'*://*.trakt.tv/*',
					...getServices()
						.map((service) => service.hostPatterns)
						.flat(),
				],
			};
			browser.webRequest.onBeforeSendHeaders.addListener(this.onBeforeSendHeaders, filters, [
				'blocking',
				'requestHeaders',
			]);
		} else if (
			!grantCookies &&
			browser.webRequest.onBeforeSendHeaders.hasListener(this.onBeforeSendHeaders)
		) {
			browser.webRequest.onBeforeSendHeaders.removeListener(this.onBeforeSendHeaders);
		}
	}

	/**
	 * Makes sure cookies are set for requests.
	 */
	onBeforeSendHeaders = ({ requestHeaders }: WebExtWebRequest.BlockingResponse) => {
		if (!requestHeaders) {
			return;
		}
		const utsCookies = requestHeaders.find((header) => header.name.toLowerCase() === 'uts-cookie');
		if (!utsCookies) {
			return;
		}
		requestHeaders = requestHeaders.filter((header) => header.name.toLowerCase() !== 'cookie');
		utsCookies.name = 'Cookie';
		return {
			requestHeaders,
		};
	};

	checkTabListener() {
		if (!browser.tabs.onRemoved.hasListener(this.onTabRemoved)) {
			browser.tabs.onRemoved.addListener(this.onTabRemoved);
		}
	}

	onTabRemoved = (tabId: number) => {
		this.cancelTabRequests(tabId);
	};

	onRequestsCancel = (data: RequestsCancelData) => {
		this.cancelRequests(data.tabId !== null ? `${data.tabId}_${data.key}` : data.key);
	};

	cancelRequests(key: string) {
		const abortController = this.abortControllers.get(key);
		if (abortController) {
			abortController.abort();
			this.abortControllers.delete(key);
		}
		this.removeCanceledRequestsFromQueue();
	}

	cancelTabRequests(tabId: number) {
		const entries = [...this.abortControllers.entries()].filter(([key]) =>
			key.startsWith(`${tabId}_`)
		);
		for (const [key, abortController] of entries) {
			abortController.abort();
			this.abortControllers.delete(key);
		}
		this.removeCanceledRequestsFromQueue();
	}

	enqueue(request: RequestDetails, tabId: number | null): Promise<string> {
		let promiseResolve: (value: string) => void = () => {
			/* Empty */
		};
		let promiseReject: (err: unknown) => void = () => {
			/* Empty */
		};
		const promise = new Promise<string>((resolve, reject) => {
			promiseResolve = resolve;
			promiseReject = reject;
		});

		const cancelKey = `${tabId !== null ? `${tabId}_` : ''}${request.cancelKey || 'default'}`;
		if (!this.abortControllers.has(cancelKey)) {
			this.abortControllers.set(cancelKey, new AbortController());
		}
		request.signal = this.abortControllers.get(cancelKey)?.signal;

		const rateLimit = request.rateLimit ?? Requests.getRateLimit(request);
		const priority = request.priority || RequestPriority.NORMAL;

		let queue = this.queue[rateLimit.id];
		if (!queue) {
			queue = {
				id: rateLimit.id,
				items: [],
				isRunning: false,
				lastRequestAtMs: 0,
			};
			this.queue[rateLimit.id] = queue;
		}

		const numItems = queue.items.length;
		let itemIndex = 0;
		while (itemIndex < numItems && queue.items[itemIndex].priority >= priority) {
			itemIndex++;
		}

		const item: RequestsQueueItem = {
			request,
			tabId,
			rateLimit,
			priority,
			addedAtMs: Date.now(),
			promiseResolve,
			promiseReject,
		};
		if (itemIndex < numItems) {
			queue.items.splice(itemIndex, 0, item);
		} else {
			queue.items.push(item);
		}

		if (!queue.isRunning) {
			this.runQueue(queue);
		}

		return promise;
	}

	runQueue(queue: RequestsQueue) {
		queue.isRunning = true;

		const nextItem = queue.items[0];
		if (nextItem) {
			if (Date.now() - queue.lastRequestAtMs > 1000 / nextItem.rateLimit.maxRPS) {
				Requests.send(nextItem.request, nextItem.tabId)
					.then((value) => {
						queue.items.shift();
						queue.lastRequestAtMs = Date.now();
						nextItem.promiseResolve(value);
						setTimeout(() => this.runQueue(queue), 0);
					})
					.catch((err) => {
						queue.items.shift();
						queue.lastRequestAtMs = Date.now();
						nextItem.promiseReject(err);
						setTimeout(() => this.runQueue(queue), 0);
					});
			} else {
				setTimeout(() => this.runQueue(queue), 0);
			}
		} else {
			queue.isRunning = false;
		}
	}

	removeCanceledRequestsFromQueue() {
		for (const queue of Object.values(this.queue)) {
			queue.items = queue.items.filter((item) => !item.request.signal?.aborted);
		}
	}
}

export const RequestsManager = new _RequestsManager();
