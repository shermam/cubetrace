import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes)],
    }).compileComponents();
  });

  it('shows the brand and a top navigation to the four pages', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('.brand')?.textContent).toBe('cubetrace');
    const links = Array.from(element.querySelectorAll('nav a'), (a) => [
      a.textContent.trim(),
      a.getAttribute('href'),
    ]);
    expect(links).toEqual([
      ['Timer', '/'],
      ['Sessions', '/sessions'],
      ['Settings', '/settings'],
      ['Probe', '/probe'],
    ]);
  });
});
