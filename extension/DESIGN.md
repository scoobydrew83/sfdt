---
name: High-Utility Developer Hub
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#393939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1c1b1b'
  surface-container: '#201f1f'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353534'
  on-surface: '#e5e2e1'
  on-surface-variant: '#bdc8d1'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#88929b'
  outline-variant: '#3e4850'
  surface-tint: '#84cfff'
  primary: '#84cfff'
  on-primary: '#00344c'
  primary-container: '#00a1e0'
  on-primary-container: '#00334a'
  inverse-primary: '#00658e'
  secondary: '#c8c6c5'
  on-secondary: '#303030'
  secondary-container: '#474746'
  on-secondary-container: '#b7b5b4'
  tertiary: '#ffb867'
  on-tertiary: '#482900'
  tertiary-container: '#d5850b'
  on-tertiary-container: '#472900'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#c7e7ff'
  primary-fixed-dim: '#84cfff'
  on-primary-fixed: '#001e2e'
  on-primary-fixed-variant: '#004c6c'
  secondary-fixed: '#e5e2e1'
  secondary-fixed-dim: '#c8c6c5'
  on-secondary-fixed: '#1b1b1c'
  on-secondary-fixed-variant: '#474746'
  tertiary-fixed: '#ffddbb'
  tertiary-fixed-dim: '#ffb867'
  on-tertiary-fixed: '#2b1700'
  on-tertiary-fixed-variant: '#673d00'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353534'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  headline-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 18px
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  label-caps:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  sidebar-width: 240px
  sidebar-collapsed: 64px
  gutter: 16px
  container-padding: 24px
  card-gap: 12px
---

## Brand & Style
The design system focuses on a **High-Utility Tech** aesthetic tailored for Salesforce developers. The goal is to feel like an extension of the developer’s brain: efficient, modular, and distraction-free. 

The style blends **Minimalism** with **Corporate Modern** sensibilities. It prioritizes information density and technical precision over decorative elements. The UI uses a "Workbench" metaphor—tools are organized into logical modules, and the interface recedes to let the developer’s data and code take center stage. The emotional response should be one of reliability, speed, and professional empowerment.

## Colors
The palette is optimized for long coding sessions and high-contrast readability. 

- **Primary Action:** Salesforce Blue (#00A1E0) is used exclusively for primary buttons, active states, and critical paths to maintain brand continuity within the ecosystem.
- **Backgrounds:** A deep Charcoal (#121212) provides the foundation for dark mode, while pure White is used for light mode.
- **Surfaces:** Dark Slate (#1E1E1E) or soft Grey (#F4F6F9) creates subtle elevation for cards and sidebars.
- **Semantic Colors:** Success (Green), Warning (Amber), and Error (Red) are saturated to stand out against dark backgrounds, ensuring critical system statuses are never missed.

## Typography
Typography is driven by **Inter** for its exceptional legibility in UI applications. To cater to the developer-centric nature of this design system, **JetBrains Mono** is introduced for technical labels, IDs, and code snippets.

The scale is compact to support data-heavy views without feeling cluttered. "Label-caps" are used for section headers within the sidebar and settings to provide clear categorization. Use "body-sm" for the majority of the data grid content to maximize the information visible on screen.

## Layout & Spacing
The layout follows a **Fluid Grid** model within a modular container. The system is designed to respond to the constraints of a Chrome Extension popup and a full-screen workspace.

- **Sidebar:** A collapsible navigation component that shifts between 240px and 64px. It anchors the left side of the experience.
- **Main Dashboard:** Uses a CSS Grid for "Tool Cards" that reflow based on available width.
- **Rhythm:** A 4px base unit ensures consistent alignment. Margins and gutters are strictly enforced at 16px (4 units) or 24px (6 units) to maintain a structured, "engineered" feel.

## Elevation & Depth
Visual hierarchy is established through **Tonal Layers** rather than heavy shadows, keeping the UI feel "flat" and fast.

- **Level 0 (Background):** Deep Charcoal (#121212). The foundation.
- **Level 1 (Cards/Sidebar):** Dark Slate (#1E1E1E). Used for modular components.
- **Level 2 (Dropdowns/Modals):** Dark Slate with a 1px border (#333333) and an **Ambient Shadow** (0 4px 12px rgba(0,0,0,0.4)). This ensures temporary elements pop against the primary interface.
- **Outlines:** Low-contrast 1px borders are preferred over shadows for input fields and grid items to maintain a crisp, technical look.

## Shapes
The design system utilizes **Soft** geometry (4px radius) to maintain a professional, modern appearance that feels precise but not aggressive. 

- **Standard Elements:** 4px (0.25rem) for buttons, inputs, and cards.
- **Status Pills:** Fully rounded (pill-shaped) for tag-like indicators and badges.
- **Large Containers:** 8px (0.5rem) for main workspace panels to soften the overall layout.

## Components
- **Tool Cards:** Modular grid items with a header (Icon + Title), a brief description in "body-sm," and a primary blue border on hover to indicate interactivity.
- **Sidebar Items:** Clear, line-weight icons paired with "body-md" text. Active states use a left-aligned Salesforce blue "accent bar" (3px wide).
- **Buttons:**
    - *Primary:* Solid Salesforce Blue with white text.
    - *Secondary:* Ghost style with 1px slate border and blue text.
- **Inputs & Toggles:** Inputs feature a subtle 1px border that glows Salesforce Blue on focus. Toggles are compact, using the primary blue for the "on" state.
- **Code Snippets:** Encapsulated in a Level 1 surface with JetBrains Mono, providing a distinct visual break from the standard UI typography.
- **Status Indicators:** Small 8px dots or subtle background tints using the semantic palette (Success/Warning/Error).