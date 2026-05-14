// Default AI prompt templates — ported from
// /Users/dkennedy/dev/2.0.2_0 copy/config/default-ai-prompt-templates.js.
//
// Verbatim port of the 5 shipped templates. The prompt bodies are preserved
// character-for-character because they have been tuned against real model
// behaviour (the draw-io template in particular relies on exact phrasing to
// keep ChatGPT from wrapping the XML in commentary).

export type PromptContext = 'flow-canvas';

export type PromptCategory =
  | 'Documentation'
  | 'Debugging'
  | 'Analysis'
  | 'Optimization'
  | 'Diagramming'
  | 'Testing'
  | 'Explanation';

export interface DefaultPromptTemplate {
  id: string;
  title: string;
  description: string;
  category: PromptCategory;
  contexts: readonly PromptContext[];
  prompt: string;
  isFallbackDefault?: boolean;
}

export const DEFAULT_PROMPT_TEMPLATES: readonly DefaultPromptTemplate[] = Object.freeze([
  {
    id: 'summarise',
    title: 'Summarise Flow',
    description: "Produces a plain-English summary suitable for the Flow's Description field.",
    category: 'Documentation',
    contexts: ['flow-canvas'],
    isFallbackDefault: true,
    prompt: `You are a Salesforce Flow documentation expert. Analyse the following Salesforce Flow metadata (JSON) and write a clear, concise plain-English description of what this Flow does.

Your description should include:
- The Flow type (Screen Flow, Record-Triggered, Scheduled, etc.) and how it is triggered
- The Salesforce objects it interacts with and the operations it performs (create, read, update, delete)
- A step-by-step summary of the logic, including any decision branches and their conditions
- Any input variables the Flow expects and any output it produces
- Any notable patterns such as loops, subflows, or external service calls

Keep the description suitable for pasting directly into the Flow's Description field in Salesforce Setup. Aim for 3-6 paragraphs — detailed enough to be useful but concise enough to read quickly.

Here is the Flow metadata:

`,
  },
  {
    id: 'describe-elements',
    title: 'Generate Flow, Element, and Resource Descriptions',
    description:
      'Produces a readable Flow summary plus grouped element and resource descriptions with paste-ready code snippets.',
    category: 'Documentation',
    contexts: ['flow-canvas'],
    prompt: `You are a Salesforce Flow documentation expert. Analyse the following Salesforce Flow metadata (JSON) and generate well-formatted, admin-friendly documentation for the Flow.

Your output must include:
1. A short paragraph summarising the Flow and its purpose
2. A paste-ready Flow description in its own code block for the Flow Description field
3. A "Flow Elements" section grouped by element type, such as Assignments, Decisions, Record Lookups, Record Creates, Record Updates, Loops, Actions, Screens, Subflows, and so on
4. A "Resources" section grouped by resource type, such as Variables, Formulas, Constants, Text Templates, and so on
5. For each element or resource, provide:
   - the item name as a heading
   - a short readable explanation
   - a separate paste-ready description in its own code block

Formatting rules:
- Use markdown headings and subheadings for structure
- Do not include the Start element
- Group Flow elements by type
- Group resources by type
- After the readable Flow summary, include a section titled "Paste-ready Flow Description"
- For each element or resource, use this structure exactly:

#### <Item Name>
Explanation: <short readable explanation>

Paste-ready description:
\`\`\`text
<short description suitable for the Salesforce Description field>
\`\`\`

Content rules:
- The Flow Summary should be a short paragraph written in plain English
- The paste-ready Flow Description should be shorter than the readable Flow Summary and suitable for direct paste into the Salesforce Flow Description field
- Keep explanations concise but useful to an admin or consultant reviewing the Flow
- Keep each paste-ready description shorter than the explanation and suitable for direct copy/paste into Salesforce
- For decisions, explain the branch logic in simple terms
- For variables, state whether they are input, output, and/or collection variables and what they are used for
- For formulas, explain what they calculate
- For assignments, explain what value or records are being set, added, or changed
- For record operations, state the object involved and the key criteria or action performed
- For actions or subflows, state what is being called and why
- Do not invent behaviour that is not present in the metadata

Use this overall structure exactly:

## Flow Summary
<short paragraph>

### Paste-ready Flow Description
\`\`\`text
<short description for the Flow Description field>
\`\`\`

## Flow Elements

### <Element Type>

#### <Element Name>
Explanation: <short readable explanation>

Paste-ready description:
\`\`\`text
<short description>
\`\`\`

## Resources

### <Resource Type>

#### <Resource Name>
Explanation: <short readable explanation>

Paste-ready description:
\`\`\`text
<short description>
\`\`\`

Here is the Flow metadata:

`,
  },
  {
    id: 'draw-io',
    title: 'Generate Draw.io Diagram',
    description: 'Produces Draw.io compatible XML for a visual flow diagram.',
    category: 'Diagramming',
    contexts: ['flow-canvas'],
    prompt: `You are an expert at converting structured process metadata into Draw.io / diagrams.net XML source.

Task:
Transform the Salesforce Flow metadata JSON below into a single Draw.io XML document.

Important:
- This is a source-code generation task, not an image-generation task
- Return exactly one markdown code block fenced with xml
- Put the entire response inside that single code block
- The opening code fence must appear immediately before the first character of the XML
- The closing code fence must appear immediately after the last character of the XML
- Do not include any text, explanation, headings, notes, or blank lines before or after the code block
- Do not output multiple code blocks
- Do not output placeholders such as "...", "[...]", or "omitted"

Required XML structure:
- Use this exact document structure:
\`\`\`xml
<mxfile>
  <diagram id="page-1" name="Page-1">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        ...
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
\`\`\`

Validation rules:
- All mxCell ids must be unique
- The root XML element must be <mxfile>
- <mxfile> must contain exactly one <diagram>
- <diagram> must contain exactly one <mxGraphModel>
- The XML must be well-formed and suitable for import into Draw.io / diagrams.net
- For Start and End ellipses, include perimeter=ellipsePerimeter in the style
- For Decision diamonds, include perimeter=rhombusPerimeter in the style
- XML-escape special characters in labels where needed
- If uncertain, still return one complete best-effort XML document inside one xml code block

Diagram requirements:
- Arrange the layout top-to-bottom following the Flow's logical sequence
- Use colour-coded shapes for different element types:
  - Green circle for Start
  - Blue rectangles for Screens
  - Yellow diamonds for Decisions
  - Orange rectangles for Assignments
  - Pink rectangles for Get Records / Create Records / Update Records / Delete Records
  - Purple rectangles for Loops
  - Dark blue rectangles for Actions (Apex, Subflows, etc.)
  - Red rectangles for Transforms
  - Red circle for End
- Label each element with its label, not API name
- Label each connector with the relevant outcome or path name
- Include decision outcome labels on each branch
- Use clear spacing and alignment so the imported diagram is readable

Here is the Flow metadata:

`,
  },
  {
    id: 'improvements',
    title: 'Suggest Improvements',
    description: 'Analyses the Flow for best practice violations and improvement opportunities.',
    category: 'Optimization',
    contexts: ['flow-canvas'],
    prompt: `You are a Salesforce Flow best practices expert. Analyse the following Salesforce Flow metadata (JSON) and provide specific, actionable suggestions for improvement.

Evaluate the Flow against these categories:

1. **Performance**: DML or SOQL operations inside loops, unnecessary record queries, missing filters that could return too many records, opportunities to use batch operations
2. **Error Handling**: Missing fault paths on record operations and actions, missing null checks after Get Records elements
3. **Maintainability**: Missing descriptions on elements and resources, unclear or inconsistent naming conventions, overly complex logic that should be broken into subflows
4. **Security**: Hardcoded record IDs, missing permission checks, sensitive data handling
5. **Governor Limits**: Patterns that risk hitting Apex governor limits in high-volume scenarios
6. **General Best Practices**: Unused variables or resources, redundant elements, opportunities to simplify logic

For each issue found:
- State the category
- Identify the specific element or resource by name
- Explain the problem
- Provide a concrete recommendation for fixing it

If the Flow follows best practices well in any category, say so briefly. Prioritise the most impactful issues first.

Here is the Flow metadata:

`,
  },
  {
    id: 'test-scenarios',
    title: 'Generate Test Scenarios',
    description: 'Produces test cases that exercise each path through the Flow.',
    category: 'Testing',
    contexts: ['flow-canvas'],
    prompt: `You are a Salesforce testing expert. Analyse the following Salesforce Flow metadata (JSON) and generate a comprehensive set of test scenarios that would exercise every path through this Flow.

For each test scenario, provide:
- **Scenario Name**: A short descriptive name
- **Description**: What this scenario tests
- **Preconditions**: What data or state needs to exist before running the Flow
- **Input Values**: Specific values for input variables and screen inputs
- **Steps**: The expected path through the Flow's elements
- **Expected Outcome**: What should happen when the Flow completes (records created/updated, screens displayed, variables set, etc.)

Make sure the scenarios cover:
- The happy path (main success scenario)
- Each decision branch, including default outcomes
- Edge cases (empty collections, null values, boundary conditions)
- Error scenarios (where fault paths exist)
- Any loops with zero items, one item, and multiple items

Present the scenarios in a numbered list, ordered from most critical to least critical. Format the output so it could be used directly as a test plan.

Here is the Flow metadata:

`,
  },
]);

export function getDefaultPromptById(id: string): DefaultPromptTemplate | null {
  return DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === id) ?? null;
}

export function assembleDefaultPrompt(id: string, metadataJson: string): string | null {
  const template = getDefaultPromptById(id);
  if (!template) return null;
  return template.prompt + metadataJson;
}

export function getFallbackDefaultPromptId(): string {
  const fallback = DEFAULT_PROMPT_TEMPLATES.find((t) => t.isFallbackDefault === true);
  return fallback?.id ?? (DEFAULT_PROMPT_TEMPLATES[0]?.id ?? '');
}
