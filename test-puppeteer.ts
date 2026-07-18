import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

async function test() {
  try {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({
      headless: 'shell',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    console.log('Browser launched successfully!');
    const page = await browser.newPage();
    await page.goto('https://example.com');
    console.log('Page title:', await page.title());
    await browser.close();
    console.log('Test completed successfully!');
  } catch (err) {
    console.error('Test failed:', err);
  }
}

test();
