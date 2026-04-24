---
name: sf-lwc
description: Lightning Web Component development guidance — component structure, wire adapters, event patterns, SLDS styling, accessibility, and common pitfalls. Activates when working on LWC files (.js-meta.xml, .html, .js for LWC).
triggers:
  - lwc
  - lightning web component
  - ".js-meta.xml"
  - wire adapter
  - lightning-
  - component
---

# Lightning Web Component (LWC) Development Skill

You are an LWC expert. This project has 14 LWC components.

## Component Structure

Every LWC component needs these files:
```
force-app/main/default/lwc/
└── myComponent/
    ├── myComponent.html          # Template
    ├── myComponent.js            # Controller
    ├── myComponent.js-meta.xml   # Metadata / exposure config
    ├── myComponent.css           # Scoped styles (optional)
    └── __tests__/
        └── myComponent.test.js  # Jest tests (optional)
```

## Component Metadata (js-meta.xml)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>63.0</apiVersion>
    <isExposed>true</isExposed>
    <!-- Where the component can be used -->
    <targets>
        <target>lightning__RecordPage</target>
        <target>lightning__AppPage</target>
        <target>lightning__HomePage</target>
    </targets>
    <!-- Properties visible in App Builder -->
    <targetConfigs>
        <targetConfig targets="lightning__RecordPage">
            <property name="recordId" type="String"/>
            <property name="title" type="String" default="My Component"/>
        </targetConfig>
    </targetConfigs>
</LightningComponentBundle>
```

## JavaScript Controller Patterns

### Basic component with @api, @track, @wire
```javascript
import { LightningElement, api, wire, track } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getContacts from '@salesforce/apex/ContactController.getContacts';
import NAME_FIELD from '@salesforce/schema/Account.Name';

export default class MyComponent extends LightningElement {
    @api recordId;          // Passed from parent or page
    @track contacts = [];   // Reactive internal state

    error;
    isLoading = false;

    // Wire: reactive — auto-refreshes when recordId changes
    @wire(getRecord, { recordId: '$recordId', fields: [NAME_FIELD] })
    wiredAccount({ error, data }) {
        if (data) {
            this.accountName = getFieldValue(data, NAME_FIELD);
        } else if (error) {
            this.handleError(error);
        }
    }

    // Wire Apex method (read-only, reactive)
    @wire(getContacts, { accountId: '$recordId' })
    wiredContacts({ error, data }) {
        if (data) {
            this.contacts = data;
        } else if (error) {
            this.handleError(error);
        }
    }

    handleError(error) {
        const message = error?.body?.message || error?.message || 'Unknown error';
        this.dispatchEvent(new ShowToastEvent({
            title: 'Error',
            message,
            variant: 'error'
        }));
    }

    // Imperative Apex call (for mutations or conditional calls)
    async handleSave() {
        this.isLoading = true;
        try {
            await saveData({ data: this.contacts });
            this.dispatchEvent(new ShowToastEvent({
                title: 'Success',
                message: 'Saved successfully',
                variant: 'success'
            }));
        } catch (error) {
            this.handleError(error);
        } finally {
            this.isLoading = false;
        }
    }
}
```

## Template Patterns

```html
<template>
    <!-- Conditional rendering -->
    <template lwc:if={isLoading}>
        <lightning-spinner alternative-text="Loading"></lightning-spinner>
    </template>

    <template lwc:else>
        <!-- Iteration -->
        <template for:each={contacts} for:item="contact">
            <div key={contact.Id} class="slds-m-bottom_small">
                <lightning-tile label={contact.Name}>
                    <p>{contact.Email}</p>
                </lightning-tile>
            </div>
        </template>

        <!-- Empty state -->
        <template lwc:if={isEmpty}>
            <div class="slds-illustration slds-illustration_small">
                <p class="slds-text-color_weak">No records found</p>
            </div>
        </template>
    </template>
</template>
```

**Template Rules — CRITICAL:**
- **`lwc:if` / `lwc:elseif` / `lwc:else` are the ONLY valid conditionals** — `if:true` and `if:false` are DEPRECATED and must never be written in new code or reviews
- **No ternary operators in templates**: `{a ? b : c}` is NOT supported — move to a JavaScript getter
- No `innerHTML` — use `lightning-formatted-rich-text` for HTML content
- Each `for:each` item needs a unique `key` attribute on the direct child element

## Event Communication

**Event naming rules:**
- Use **short, lowercase action verbs**: `select`, `close`, `save`, `delete` — NOT compound names like `memberselect` or `cardClick`
- Listener attribute = `on` + event name: `select` → `onselect`, `close` → `onclose`
- Set `bubbles: true` for parent-child events (allows propagation); `composed: false` keeps it within shadow boundary

```javascript
// Child fires event
handleClick() {
    const event = new CustomEvent('select', {
        detail: { id: this.recordId, name: this.name },
        bubbles: true,   // propagates up DOM — use true for parent-child
        composed: false  // stays within shadow boundary (use false)
    });
    this.dispatchEvent(event);
}
```

```html
<!-- Parent listens: on + event name ('select' → 'onselect') -->
<c-child-component onselect={handleChildSelect}></c-child-component>
```

```javascript
// Parent handler
handleChildSelect(event) {
    const { id, name } = event.detail;
    // process...
}
```

## SLDS Styling

Use SLDS utility classes — never write custom CSS that duplicates SLDS:

```html
<!-- Layout -->
<div class="slds-grid slds-wrap slds-gutters">
    <div class="slds-col slds-size_1-of-2">Column 1</div>
    <div class="slds-col slds-size_1-of-2">Column 2</div>
</div>

<!-- Spacing -->
<div class="slds-m-top_medium slds-p-horizontal_small">Content</div>

<!-- Typography -->
<p class="slds-text-heading_medium slds-text-color_weak">Subtitle</p>

<!-- Cards -->
<div class="slds-card slds-card_boundary">
    <div class="slds-card__header">...</div>
    <div class="slds-card__body slds-card__body_inner">...</div>
</div>
```

## Common Anti-Patterns to Avoid

```javascript
// BAD: Direct DOM manipulation
this.template.querySelector('.myClass').style.display = 'none';
// GOOD: Use tracked property + conditional template rendering

// BAD: setTimeout for async work
setTimeout(() => this.loadData(), 1000);
// GOOD: Use @wire or async/await

// BAD: console.log left in production
console.log('debug:', this.data);
// GOOD: Remove before commit

// BAD: Unhandled promise
this.loadData();
// GOOD: await with try/catch, or .catch(this.handleError.bind(this))
```

## Standard Lightning Components Quick Reference

```html
<lightning-button label="Save" onclick={handleSave} variant="brand"></lightning-button>
<lightning-input label="Name" value={name} onchange={handleNameChange}></lightning-input>
<lightning-combobox label="Status" value={status} options={statusOptions} onchange={handleStatusChange}></lightning-combobox>
<lightning-datatable key-field="Id" data={contacts} columns={columns}></lightning-datatable>
<lightning-record-form record-id={recordId} object-api-name="Account" fields={fields}></lightning-record-form>
<lightning-record-edit-form record-id={recordId} object-api-name="Contact">
    <lightning-input-field field-name="FirstName"></lightning-input-field>
    <lightning-button type="submit" label="Save"></lightning-button>
</lightning-record-edit-form>
```
