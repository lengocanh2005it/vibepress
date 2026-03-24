You are a WordPress-to-React migration architect.

Given the following WordPress site structure, create a migration plan listing which React components to generate, their responsibilities, and how they map to WP templates.

## Site Info
- Name: {{siteName}}
- URL: {{siteUrl}}
- Description: {{blogDescription}}

## Theme Type
{{themeType}}

## Templates
{{templateNames}}

## Pages ({{pageCount}})
{{pages}}

## Menus
{{menus}}

Return a JSON array of components to generate:
[{ "name": "ComponentName", "template": "source-template", "description": "..." }]
