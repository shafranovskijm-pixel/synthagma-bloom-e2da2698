import { describe, expect, it } from 'vitest';
import {
  forceProxyMode,
  installProxyFetch,
  rewriteSupabaseResourceAttribute,
  rewriteSupabaseUrl,
} from '../proxyFetch';

const SUPABASE = 'https://atxwvjxbqjgkbjlhsdch.supabase.co';
const PROXY = 'https://api.xn--80aaiswd0ak.xn--p1ai';

describe('Supabase resource proxy', () => {
  it('routes public storage objects through the Nginx storage prefix', () => {
    expect(
      rewriteSupabaseUrl(`${SUPABASE}/storage/v1/object/public/course-files/cover.webp?width=900`),
    ).toBe(`${PROXY}/sb-storage/object/public/course-files/cover.webp?width=900`);
  });

  it('routes signed and transformed storage URLs without losing query parameters', () => {
    expect(
      rewriteSupabaseUrl(`${SUPABASE}/storage/v1/render/image/sign/covers/a.png?token=abc&width=400`),
    ).toBe(`${PROXY}/sb-storage/render/image/sign/covers/a.png?token=abc&width=400`);
  });

  it('keeps unrelated external URLs unchanged', () => {
    const url = 'https://cdn.example.com/images/cover.webp';
    expect(rewriteSupabaseUrl(url)).toBe(url);
  });

  it('rewrites every Supabase candidate in srcset', () => {
    const value = `${SUPABASE}/storage/v1/object/public/covers/a.webp 1x, ${SUPABASE}/storage/v1/object/public/covers/a@2x.webp 2x`;
    expect(rewriteSupabaseResourceAttribute('srcset', value)).toBe(
      `${PROXY}/sb-storage/object/public/covers/a.webp 1x, ${PROXY}/sb-storage/object/public/covers/a@2x.webp 2x`,
    );
  });

  it('rewrites Supabase URLs inside inline background styles', () => {
    const value = `background-image: linear-gradient(#0003, #0003), url("${SUPABASE}/storage/v1/object/public/covers/a.webp")`;
    expect(rewriteSupabaseResourceAttribute('style', value)).toBe(
      `background-image: linear-gradient(#0003, #0003), url("${PROXY}/sb-storage/object/public/covers/a.webp")`,
    );
  });

  it('rewrites image and CSS property assignments before the browser loads them', () => {
    window.fetch ??= globalThis.fetch.bind(globalThis);
    forceProxyMode(true);
    installProxyFetch();

    const image = document.createElement('img');
    image.src = `${SUPABASE}/storage/v1/object/public/covers/dom.webp`;
    expect(image.getAttribute('src')).toBe(`${PROXY}/sb-storage/object/public/covers/dom.webp`);

    const banner = document.createElement('div');
    banner.style.backgroundImage = `url("${SUPABASE}/storage/v1/object/public/covers/banner.webp")`;
    expect(banner.style.backgroundImage).toContain(
      `${PROXY}/sb-storage/object/public/covers/banner.webp`,
    );

    forceProxyMode(false);
  });
});
