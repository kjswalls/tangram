import { describe, it } from 'vitest';
import { createBackNavigation } from './__probe_bn';
const SEVEN = ['/', '/lookup', '/review', '/read', '/lists', '/stats', '/settings'];
describe('probe', () => {
  it('trace', () => {
    const nav = createBackNavigation(SEVEN);
    nav.visit('/lookup');
    nav.visit('/entry/中文');
    console.log('after entry:', JSON.stringify(nav.snapshot()));
    const a1 = nav.handleBack({ overlayOpen: false });
    console.log('press1:', JSON.stringify(a1));
    // the router then reports the POP arrival
    nav.visit('/lookup', 'POP');
    console.log('after pop arrival:', JSON.stringify(nav.snapshot()));
    const a2 = nav.handleBack({ overlayOpen: false });
    console.log('press2:', JSON.stringify(a2));
    nav.visit('/', 'PUSH');
    console.log('after switch arrival:', JSON.stringify(nav.snapshot()));
    const a3 = nav.handleBack({ overlayOpen: false });
    console.log('press3:', JSON.stringify(a3));
  });
});
