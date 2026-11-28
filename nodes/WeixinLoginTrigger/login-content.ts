import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const icon = readFileSync(join(__dirname, '../../assets/icon.svg')).toString('base64');

export const loginCss = `
	#n8n-form .form-header h1 { display: flex; align-items: center; justify-content: center; gap: 10px; }
	#n8n-form .form-header h1::before {
		content: '';
		flex: 0 0 36px;
		height: 36px;
		background: center / contain no-repeat url("data:image/svg+xml;base64,${icon}");
	}
	#submit-btn, #weixin-content { display: none; }
	#weixin-login { text-align: center; }
	#weixin-qr { display: block; width: 280px; max-width: 100%; height: auto; margin: auto; }
	#weixin-qr[hidden] { display: none; }
	#weixin-login button { margin-top: 8px; cursor: pointer; }
`;

export function loginContent(id: string, image: string) {
	return `
		<div id="weixin-login">
			<img id="weixin-qr" alt="Weixin login QR code" width="280" height="280" src="${image}">
			<p id="weixin-status" role="status" aria-live="polite">Scan the QR code in Weixin.</p>
			<div id="weixin-pin-panel" hidden>
				<label class="form-label" for="weixin-pin">PIN</label>
				<input id="weixin-pin" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8">
				<button type="button" id="weixin-confirm">Submit PIN</button>
			</div>
			<button type="button" id="weixin-refresh" hidden>Get a new QR code</button>
		</div>
		<script>
			(() => {
				const qr = document.getElementById('weixin-qr');
				const message = document.getElementById('weixin-status');
				const pinPanel = document.getElementById('weixin-pin-panel');
				const pin = document.getElementById('weixin-pin');
				const confirm = document.getElementById('weixin-confirm');
				const refresh = document.getElementById('weixin-refresh');
				let timer;
				let pending = false;
				const messages = {
					wait: 'Scan the QR code in Weixin.',
					scaned: 'QR code scanned. Confirm the connection in Weixin.',
					scaned_but_redirect: 'QR code scanned. Confirm the connection in Weixin.',
					expired: 'The QR code expired.',
					verify_code_blocked: 'PIN attempts exceeded. Request a new QR code.',
					failed: 'Could not connect to Weixin.',
					binded_redirect: 'This account is already bound. Use the existing credential or disconnect the previous binding before trying again.',
					confirmed: 'Scan confirmed. Return to the n8n editor and copy the output into a Weixin API credential.',
					ended: 'The test session ended. Restart the listener in n8n.'
				};
				async function check(action, code) {
					if (pending) return;
					clearTimeout(timer);
					pending = true;
					confirm.disabled = refresh.disabled = true;
					try {
						const body = new URLSearchParams({ session: '${id}', action: action || 'status' });
						if (code) body.set('pin', code);
						const response = await fetch(location.href, { method: 'POST', body, credentials: 'omit' });
						const result = response.status === 404 || response.status === 410
							? { status: 'ended' }
							: await response.json();
						const state = result.status;
						const needsPin = state.includes('need_verifycode');
						const canRefresh = ['expired', 'verify_code_blocked', 'failed'].includes(state);
						const finished = ['confirmed', 'ended', 'binded_redirect'].includes(state);
						if (result.image) qr.src = result.image;
						qr.hidden = finished;
						qr.style.opacity = canRefresh ? '.25' : '';
						pinPanel.hidden = !needsPin;
						refresh.hidden = !canRefresh;
						const nextMessage = needsPin ? 'Enter the PIN shown in Weixin.' : messages[state] || messages.wait;
						if (message.textContent !== nextMessage) message.textContent = nextMessage;
						if (!finished && !canRefresh && !needsPin) timer = setTimeout(check, 1500);
						if (needsPin) pin.focus();
					} catch {
						message.textContent = 'Connection interrupted. Retrying…';
						timer = setTimeout(check, 2500);
					} finally {
						pending = false;
						confirm.disabled = refresh.disabled = false;
					}
				}
				confirm.onclick = () => {
					if (pin.value && pin.reportValidity()) {
						const code = pin.value;
						pin.value = '';
						void check('pin', code);
					}
				};
				pin.addEventListener('keydown', (event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						confirm.click();
					}
				});
				refresh.onclick = () => { void check('refresh'); };
				timer = setTimeout(check, 1500);
			})();
		</script>
	`;
}
