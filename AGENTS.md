### Your Task

- We want you to build a AI teleprompter web app.
- Teleprompters show a script in large text so they are easy to read back, and they typically scroll at a constant pace.
- We want you to build a teleprompter that scrolls automatically as you are reading it back.
- Within reason, we are not cost-sensitive, we want the absolute best user experience.
- What the app might look like:
    - You have a text box where you can write a script or paste one in.
    - There’s a “Read back Script” button.
    - When you hit that button, then you display the script in large text. As you read out the script, the script should scroll as you are reading the script (i.e. by transcribing your speech).
### Some tricky parts

- There are two big tricky parts here:
    - Latency
    - Support going-off-script
- Your solution should try to support both.

**Latency**

- This is a very latency sensitive experience – as you read back at normal speed, the upcoming text should always be visible.
- The text in the teleprompter should be large – e.g. only ~5 words per line (so that your eyes don’t move too far horizontally)
- You can only have a max ~4 lines on the screen at once (otherwise your eyes will move too much vertically).

**Going-off-script**

- Critically, users also may not *perfectly* read back the script.
- They might ad-lib or interject phrases or sentences that are not in the original script.
- They might rephrase words or sentences heavily as they go.
- They might miss words out or mispronounce words.