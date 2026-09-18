# Delivery Success Sliders

MVP workshop app: GitHub Pages + Supabase + Vanilla JS + Apache ECharts.

## Setup
1. Supabase > SQL Editor: run `supabase.sql` once on a fresh project.
2. Supabase > Authentication > Users: create your admin email/password user.
3. Upload these files to the root of `degercanibek/delivery-success-sliders`.
4. GitHub repo > Settings > Pages > Deploy from `main` / root.
5. Open the site and go to `#admin`.
6. Create a session; add bilingual Groups and Success Dimensions.
7. Vote URL: `?s=SESSION-SLUG#vote`
8. Results URL: `?s=SESSION-SLUG#results`

## GoDaddy subdomain
After the default GitHub Pages URL works:
- GitHub Settings > Pages > Custom domain: e.g. `success.example.com`
- GoDaddy CNAME Host: `success`
- Points to: `degercanibek.github.io`
- Then enable Enforce HTTPS in GitHub Pages.

## Security note
The Supabase publishable key is intentionally client-side. Never add a service-role/secret key to this repo.

## MVP scope
- Turkish/English; Turkish default
- Session create/delete
- Dynamic bilingual groups and dimensions + descriptions
- Mobile anonymous voting
- Linked allocation totaling 100
- Group-by-dimension live results
- Adjustable blur + staged reveal controls
- Delete responses
